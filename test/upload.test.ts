import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const r2 = vi.hoisted(() => ({
  putFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('../src/r2.js', () => r2);
vi.mock('../src/config.js', () => {
  const dataDir = `/tmp/privateeyes-upload-tests-${process.pid}`;
  return {
    tmpDir: path.join(dataDir, 'tmp'),
    config: {
      dataDir,
      maxFileBytes: 4,
      publicBaseUrl: 'https://files.test',
      limits: {
        h8Uploads: 200,
        h8Bytes: 2_147_483_648,
        h24Uploads: 500,
        h24Bytes: 5_368_709_120,
      },
    },
  };
});

import type { DB } from '../src/db.js';
import { openDb } from '../src/db.js';
import { uploadRequest } from '../src/upload.js';
import type { Token } from '../src/tokens.js';

const TEST_TMP = `/tmp/privateeyes-upload-tests-${process.pid}/tmp`;
const databases: DB[] = [];

function makeDb() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO tokens (id,name,token_hash,created_at) VALUES (?,?,?,?)')
    .run(1, 'test', 'test-hash', new Date().toISOString());
  databases.push(db);
  return db;
}

function makeApp(db: DB, token: Token | number = 1) {
  const app = new Hono();
  app.post('/', (c) => uploadRequest(c, db, token));
  return app;
}

function formWithFile(contents: string, filename = 'note.txt', override?: string) {
  const form = new FormData();
  form.append('file', new Blob([contents]), filename);
  if (override !== undefined) form.append('name', override);
  return form;
}

async function tempFiles() {
  return fsp.readdir(TEST_TMP).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

beforeEach(async () => {
  r2.putFile.mockReset();
  r2.deleteFile.mockReset();
  await fsp.rm(TEST_TMP, { recursive: true, force: true });
});

afterEach(async () => {
  while (databases.length) databases.pop()!.close();
  await fsp.rm(TEST_TMP, { recursive: true, force: true });
});

describe('streaming uploads', () => {
  it('returns 413 during an oversized upload and removes the partial temp file', async () => {
    let sourceCancelled = false;
    const boundary = 'size-test-boundary';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n12345`,
        ));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const request = new Request('http://test/', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const response = await makeApp(makeDb()).fetch(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'file_too_large' });
    expect(sourceCancelled).toBe(true);
    expect(await tempFiles()).toEqual([]);
  });

  it('returns the winning row when another upload inserts the sha first', async () => {
    const db = makeDb();
    const digest = crypto.createHash('sha256').update('abc').digest('hex');
    const remoteKeys = new Set<string>();
    r2.putFile.mockImplementationOnce(async (_temp, key: string) => {
      remoteKeys.add(key);
      db.prepare('INSERT INTO files (id,original_name,mime,bytes,sha256,r2_key,token_id,uploaded_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('winner', 'winner.txt', 'text/plain', 3, digest, 'f/winner/winner.txt', 1, new Date().toISOString());
    });
    r2.deleteFile.mockImplementation(async (key: string) => {
      remoteKeys.delete(key);
    });

    const response = await makeApp(db).request('http://test/', {
      method: 'POST',
      body: formWithFile('abc'),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'winner', deduped: true });
    expect(remoteKeys).toEqual(new Set());
    expect(await tempFiles()).toEqual([]);
  });

  it('removes a partial temp file when the client aborts', async () => {
    const boundary = 'abort-test-boundary';
    const abortController = new AbortController();
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\nabc`,
        ));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const request = new Request('http://test/', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
      signal: abortController.signal,
    } as RequestInit & { duplex: 'half' });
    const responsePromise = makeApp(makeDb()).fetch(request);

    for (let attempt = 0; attempt < 20 && (await tempFiles()).length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await tempFiles()).toHaveLength(1);
    abortController.abort();

    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'upload_aborted' });
    expect(sourceCancelled).toBe(true);
    expect(await tempFiles()).toEqual([]);
  }, 15_000);

  it('returns 502 and removes the temp file when R2 PUT fails', async () => {
    r2.putFile.mockRejectedValueOnce(new Error('R2 unavailable'));

    const response = await makeApp(makeDb()).request('http://test/', {
      method: 'POST',
      body: formWithFile('abc'),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'storage_unavailable' });
    expect(await tempFiles()).toEqual([]);
  });

  it('enforces the exact byte quota after streaming and before R2', async () => {
    const db = makeDb();
    db.prepare('UPDATE tokens SET max_bytes=? WHERE id=?').run(2, 1);
    const token = db.prepare('SELECT * FROM tokens WHERE id=?').get(1) as Token;

    const response = await makeApp(db, token).request('http://test/', {
      method: 'POST',
      body: formWithFile('abc'),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'rate_limited', window: 'lifetime' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 0 });
    expect(await tempFiles()).toEqual([]);
  });

  it('returns 500 and removes the temp file when finalization throws unexpectedly', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('database unavailable');
      },
    } as unknown as DB;

    const response = await makeApp(brokenDb).request('http://test/', {
      method: 'POST',
      body: formWithFile('abc'),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'upload_failed' });
    expect(await tempFiles()).toEqual([]);
  }, 1000);

  it('streams the temp file to storage with sanitized metadata', async () => {
    let stored: { contents: string; mime: string; disposition: string } | undefined;
    r2.putFile.mockImplementationOnce(async (temp: string, _key: string, mime: string, disposition: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of fs.createReadStream(temp)) chunks.push(Buffer.from(chunk));
      stored = { contents: Buffer.concat(chunks).toString(), mime, disposition };
    });

    const response = await makeApp(makeDb()).request('http://test/', {
      method: 'POST',
      body: formWithFile('abc', 'ignored.bin', ' ../résumé.txt '),
    });

    expect(response.status).toBe(201);
    expect(stored).toEqual({
      contents: 'abc',
      mime: 'text/plain',
      disposition: 'inline; filename="résumé.txt"',
    });
    expect(await tempFiles()).toEqual([]);
  });
});
