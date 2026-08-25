import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'node:fs';
import { config } from './config.js';

export const client = new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});

export async function putFile(path: string, key: string, mime: string, disposition: string, signal?: AbortSignal) {
  const body = fs.createReadStream(path);
  const upload = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: mime,
      ContentDisposition: disposition,
    },
  });
  const abort = () => { void upload.abort().catch(() => undefined); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    await upload.done();
  } finally {
    signal?.removeEventListener('abort', abort);
    body.destroy();
  }
}

export async function deleteFile(key: string) {
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
