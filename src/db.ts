import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function openDb(filename?: string) {
  const file = filename || path.join(config.dataDir, 'privateeyes.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file); db.pragma('journal_mode = WAL'); db.pragma('user_version = 1');
  db.exec(`CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, max_uploads INTEGER, max_bytes INTEGER);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, original_name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT UNIQUE NOT NULL, r2_key TEXT NOT NULL, token_id INTEGER REFERENCES tokens(id), uploaded_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_files_token_time ON files(token_id, uploaded_at);`);
  return db;
}
export type DB = ReturnType<typeof openDb>;
