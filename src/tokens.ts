import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { DB } from './db.js';
import { config } from './config.js';

const now = () => new Date().toISOString();
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export type Token = { id:number; name:string; expires_at:string|null; revoked:number; max_uploads:number|null; max_bytes:number|null; token_hash:string };
export function mintToken(db: DB, name: string, days?: number, maxUploads?: number, maxBytes?: number) {
  const token = `pe_${nanoid(43)}`; db.prepare('INSERT INTO tokens (name,token_hash,created_at,expires_at,max_uploads,max_bytes) VALUES (?,?,?,?,?,?)').run(name, hash(token), now(), days ? new Date(Date.now()+days*86400000).toISOString() : null, maxUploads ?? null, maxBytes ?? null); return token;
}
export function verifyToken(db: DB, value?: string): { token?:Token; error?: string } {
  if (!value || !/^pe_[A-Za-z0-9_-]{43}$/.test(value)) return { error:'invalid_token' };
  const token = db.prepare('SELECT * FROM tokens WHERE token_hash=?').get(hash(value)) as Token|undefined;
  if (!token) return { error:'invalid_token' }; if (token.revoked) return { error:'revoked_token' }; if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) return { error:'expired_token' }; return { token };
}
export function usage(db: DB, tokenId: number, hours: number) { const since = new Date(Date.now()-hours*3600000).toISOString(); return db.prepare('SELECT COUNT(*) uploads, COALESCE(SUM(bytes),0) bytes FROM files WHERE token_id=? AND uploaded_at>=?').get(tokenId,since) as {uploads:number;bytes:number}; }
export function lifetime(db: DB, tokenId: number) { return db.prepare('SELECT COUNT(*) uploads, COALESCE(SUM(bytes),0) bytes FROM files WHERE token_id=?').get(tokenId) as {uploads:number;bytes:number}; }
export function rateLimit(db: DB, token: Token, bytes=0) { const u8=usage(db,token.id,8), u24=usage(db,token.id,24), life=lifetime(db,token.id); if (u8.uploads>=config.limits.h8Uploads||u8.bytes+bytes>config.limits.h8Bytes) return {window:'8h',retry_after_seconds:Math.ceil(8*3600)}; if (u24.uploads>=config.limits.h24Uploads||u24.bytes+bytes>config.limits.h24Bytes) return {window:'24h',retry_after_seconds:Math.ceil(24*3600)}; if (token.max_uploads!=null&&life.uploads>=token.max_uploads||token.max_bytes!=null&&life.bytes+bytes>token.max_bytes) return {window:'lifetime',retry_after_seconds:0}; return null; }
export { hash };
