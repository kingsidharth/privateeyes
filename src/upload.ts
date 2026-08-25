import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { nanoid } from 'nanoid';
import type { Context } from 'hono';
import type { DB } from './db.js';
import { config, tmpDir } from './config.js';
import { mimeFor, isAttachment } from './mime.js';
import { deleteFile, putFile } from './r2.js';
import { rateLimit, type Token } from './tokens.js';

type FileRow = {
  id: string;
  original_name: string;
  mime: string;
  bytes: number;
  sha256: string;
};

type UploadOutcome = {
  status: number;
  body: Record<string, unknown>;
};

class FileTooLargeError extends Error {}

export function sanitizeName(input: string) {
  const safe = input
    .replace(/[\\/]/g, '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return safe || 'file';
}

export async function uploadRequest(c: Context, db: DB, token: Token | number) {
  const contentType = c.req.header('content-type') || '';
  const body = c.req.raw.body;
  if (!body) {
    return c.json({ error: 'missing_body', message: 'request body required' }, 400);
  }

  const input = Readable.fromWeb(body as NodeReadableStream);
  const outcome = await streamUpload(input, contentType, c.req.raw.signal, db, token);
  return c.json(outcome.body, outcome.status as never);
}

async function streamUpload(
  input: Readable,
  contentType: string,
  signal: AbortSignal,
  db: DB,
  token: Token | number,
): Promise<UploadOutcome> {
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    input.destroy();
    return errorOutcome(400, 'invalid_multipart', 'multipart/form-data required');
  }

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { files: 1, fields: 10, parts: 11, fieldSize: 4096, headerPairs: 100 },
    });
  } catch {
    input.destroy();
    return errorOutcome(400, 'invalid_multipart', 'multipart/form-data required');
  }

  await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(tmpDir, crypto.randomUUID());
  const tokenId = typeof token === 'number' ? token : token.id;

  return new Promise<UploadOutcome>((resolve) => {
    const sha = crypto.createHash('sha256');
    let bytes = 0;
    let originalName = 'file';
    let overrideName: string | undefined;
    let fileSeen = false;
    let fileWrite: fs.WriteStream | undefined;
    let filePipeline: Promise<void> | undefined;
    let settled = false;
    let finalizing = false;
    let clientAborted = signal.aborted;
    let uncommittedR2Key: string | undefined;

    const cleanupTemp = async () => {
      fileWrite?.destroy();
      try {
        await fsp.rm(tempPath, { force: true });
      } catch (error) {
        console.error('failed to remove upload temp file', { tempPath, error });
      }
    };

    const finish = async (outcome: UploadOutcome, destroyInput = true) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      input.removeListener('error', onInputError);
      input.unpipe(busboy);
      if (destroyInput && !input.destroyed) input.destroy();
      if (!busboy.destroyed) busboy.destroy();
      await cleanupTemp();
      resolve(outcome);
    };

    const onAbort = () => {
      clientAborted = true;
      if (!input.destroyed) input.destroy();
      if (!finalizing) {
        void finish(errorOutcome(400, 'upload_aborted', 'upload interrupted'));
      }
    };

    const onInputError = () => {
      clientAborted = true;
      if (!finalizing) {
        void finish(errorOutcome(400, 'upload_aborted', 'upload interrupted'));
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    input.on('error', onInputError);

    busboy.on('field', (name, value, info) => {
      if (info.valueTruncated) {
        void finish(errorOutcome(400, 'invalid_upload', 'multipart field too large'));
        return;
      }
      if (name === 'name') overrideName = value;
    });

    busboy.on('file', (fieldName, file, info) => {
      if (fieldName !== 'file') {
        file.resume();
        return;
      }

      fileSeen = true;
      originalName = info.filename || 'file';
      fileWrite = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
      const hashAndLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const nextBytes = bytes + chunk.length;
          if (nextBytes > config.maxFileBytes) {
            callback(new FileTooLargeError());
            return;
          }
          bytes = nextBytes;
          sha.update(chunk);
          callback(null, chunk);
        },
      });

      filePipeline = pipeline(file, hashAndLimit, fileWrite).catch(async (error: unknown) => {
        if (error instanceof FileTooLargeError) {
          await finish(errorOutcome(413, 'file_too_large', 'file exceeds MAX_FILE_MB'));
          return;
        }
        if (!settled) {
          const outcome = clientAborted
            ? errorOutcome(400, 'upload_aborted', 'upload interrupted')
            : errorOutcome(500, 'upload_failed', 'could not stage upload');
          await finish(outcome);
        }
      });
    });

    busboy.on('error', () => {
      if (!settled) {
        void finish(errorOutcome(400, 'invalid_upload', 'invalid multipart body'));
      }
    });

    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) {
      busboy.on(event, () => {
        if (!settled) {
          void finish(errorOutcome(400, 'invalid_upload', 'multipart limits exceeded'));
        }
      });
    }

    busboy.on('finish', () => {
      void finalize();
    });

    const finalize = async () => {
      if (settled || finalizing) return;
      finalizing = true;

      try {
        if (!fileSeen || !filePipeline) {
          await finish(errorOutcome(400, 'missing_file', 'file field required'));
          return;
        }

        await filePipeline;
        if (settled) return;
        if (clientAborted) {
          await finish(errorOutcome(400, 'upload_aborted', 'upload interrupted'));
          return;
        }

        const safeName = sanitizeName(overrideName || originalName);
        const digest = sha.digest('hex');
        const existing = findBySha(db, digest);
        if (existing) {
          await finish(fileOutcome(existing, true), false);
          return;
        }

        if (typeof token !== 'number') {
          const limited = rateLimit(db, token, bytes);
          if (limited) {
            await finish({ status: 429, body: { error: 'rate_limited', ...limited } }, false);
            return;
          }
        }

        const id = nanoid(12);
        const r2Key = `f/${id}/${encodeURIComponent(safeName)}`;
        const mime = mimeFor(safeName);
        const dispositionName = safeName.replace(/"/g, '');
        const disposition = `${isAttachment(mime) ? 'attachment' : 'inline'}; filename="${dispositionName}"`;

        try {
          await putFile(tempPath, r2Key, mime, disposition, signal);
        } catch {
          const outcome = clientAborted
            ? errorOutcome(400, 'upload_aborted', 'upload interrupted')
            : errorOutcome(502, 'storage_unavailable', 'could not store file');
          await finish(outcome, false);
          return;
        }
        uncommittedR2Key = r2Key;

        if (clientAborted) {
          await removeUploadedObject(r2Key);
          uncommittedR2Key = undefined;
          await finish(errorOutcome(400, 'upload_aborted', 'upload interrupted'), false);
          return;
        }

        try {
          db.prepare(
            'INSERT INTO files (id,original_name,mime,bytes,sha256,r2_key,token_id,uploaded_at) VALUES (?,?,?,?,?,?,?,?)',
          ).run(id, safeName, mime, bytes, digest, r2Key, tokenId, new Date().toISOString());
        } catch (error) {
          const winner = isUniqueConstraint(error) ? findBySha(db, digest) : undefined;
          await removeUploadedObject(r2Key);
          uncommittedR2Key = undefined;
          if (winner) {
            await finish(fileOutcome(winner, true), false);
            return;
          }
          await finish(errorOutcome(500, 'database_error', 'could not record upload'), false);
          return;
        }
        uncommittedR2Key = undefined;

        await finish({
          status: 201,
          body: {
            url: `${config.publicBaseUrl}/f/${id}/${encodeURIComponent(safeName)}`,
            id,
            name: safeName,
            sha256: digest,
            bytes,
            mime,
            deduped: false,
          },
        }, false);
      } catch {
        if (uncommittedR2Key) await removeUploadedObject(uncommittedR2Key);
        if (!settled) {
          await finish(errorOutcome(500, 'upload_failed', 'could not finalize upload'), false);
        }
      }
    };

    if (clientAborted) {
      onAbort();
      return;
    }
    input.pipe(busboy);
  });
}

function findBySha(db: DB, sha256: string) {
  return db.prepare('SELECT * FROM files WHERE sha256=? AND deleted=0').get(sha256) as FileRow | undefined;
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Error
    && 'code' in error
    && String((error as Error & { code: unknown }).code).startsWith('SQLITE_CONSTRAINT_UNIQUE');
}

async function removeUploadedObject(key: string) {
  try {
    await deleteFile(key);
  } catch (error) {
    console.error('failed to remove uncommitted R2 object', { key, error });
  }
}

function errorOutcome(status: number, error: string, message: string): UploadOutcome {
  return { status, body: { error, message } };
}

function fileOutcome(file: FileRow, deduped: boolean): UploadOutcome {
  return {
    status: 200,
    body: {
      url: `${config.publicBaseUrl}/f/${file.id}/${encodeURIComponent(file.original_name)}`,
      id: file.id,
      name: file.original_name,
      sha256: file.sha256,
      bytes: file.bytes,
      mime: file.mime,
      deduped,
    },
  };
}
