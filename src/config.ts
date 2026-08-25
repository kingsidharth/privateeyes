import path from 'node:path';

const integer = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: integer('PORT', 8790), host: process.env.BIND_HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR || './data',
  r2AccountId: process.env.R2_ACCOUNT_ID || '', accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '', bucket: process.env.R2_BUCKET || 'privateeyes',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://privateeyes.xperiments.app').replace(/\/$/, ''),
  maxFileBytes: integer('MAX_FILE_MB', 100) * 1024 * 1024, adminPassword: process.env.ADMIN_PASSWORD || '',
  limits: { h8Uploads: integer('RL_8H_UPLOADS', 200), h8Bytes: integer('RL_8H_BYTES', 2147483648), h24Uploads: integer('RL_24H_UPLOADS', 500), h24Bytes: integer('RL_24H_BYTES', 5368709120) },
};
export const tmpDir = path.join(config.dataDir, 'tmp');
