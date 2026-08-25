# privateeyes — spec

Tailnet-gated file drop for agents. Agents on the Tailscale network POST a file,
get back a public unguessable CDN URL on Cloudflare R2.

## Stack
- TypeScript, Node 22, ESM
- Hono (server + JSX for admin pages), @hono/node-server
- better-sqlite3 (WAL mode), DB at `$DATA_DIR/privateeyes.db`
- @aws-sdk/client-s3 + @aws-sdk/lib-storage for R2 (S3-compatible)
- nanoid for ids
- No frontend framework. Admin UI is server-rendered Hono JSX + a tiny bit of vanilla JS.
- Vitest for tests.

## Config (env, all read once at startup in src/config.ts)
- PORT (default 8790), BIND_HOST (default 127.0.0.1)
- DATA_DIR (default ./data) — sqlite db + tmp upload staging dir ($DATA_DIR/tmp)
- R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default "privateeyes")
  - S3 endpoint: https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com, region "auto", forcePathStyle
- PUBLIC_BASE_URL (default https://privateeyes.xperiments.app)
- MAX_FILE_MB (default 100)
- ADMIN_PASSWORD (required for /admin)
- Rate limits: RL_8H_UPLOADS=200, RL_8H_BYTES=2147483648, RL_24H_UPLOADS=500, RL_24H_BYTES=5368709120

## SQLite schema (migrations run at startup, schema_version pragma)
```sql
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,      -- sha256 hex of full token
  created_at TEXT NOT NULL,             -- ISO8601 UTC
  expires_at TEXT,                      -- NULL = never
  revoked INTEGER NOT NULL DEFAULT 0,
  max_uploads INTEGER,                  -- lifetime, NULL = unlimited
  max_bytes INTEGER
);
CREATE TABLE files (
  id TEXT PRIMARY KEY,                  -- nanoid(12), alphabet: url-safe default
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT UNIQUE NOT NULL,
  r2_key TEXT NOT NULL,                 -- f/<id>/<safe-name>
  token_id INTEGER REFERENCES tokens(id),
  uploaded_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_token_time ON files(token_id, uploaded_at);
```
Note: sha256 UNIQUE applies to live rows; when a file is deleted we hard-DELETE the
row after removing the R2 object (keeps dedupe correct). Log deletions to stdout.

## Auth
- `Authorization: Bearer pe_<43 chars base64url>` (32 random bytes). Store sha256 hex only.
- Constant-time compare not needed (hash lookup), but hash before lookup.
- 401 JSON errors: {error: "invalid_token" | "expired_token" | "revoked_token"} with human `message`.

## POST /v1/upload  (multipart/form-data)
- field `file` (required). Optional field `name` overrides original filename.
- Enforce MAX_FILE_MB while streaming; abort with 413 if exceeded (don't buffer whole file in memory —
  stream multipart part to $DATA_DIR/tmp/<uuid> while updating an incremental sha256; clean up temp file
  on every path including client abort).
- Rate limit check BEFORE accepting body (429 with {error:"rate_limited", retry_after_seconds, window}).
  Sliding windows computed with SQL over files table (uploads by token in last 8h/24h). Lifetime quotas too.
- Dedupe: if sha256 exists (non-deleted), delete temp, return existing record with `deduped: true`, 200.
- Otherwise: id = nanoid(12); safe name = original name, unicode allowed but strip path separators,
  control chars, leading dots; fallback "file". r2_key = `f/${id}/${encodeURIComponent-safe name}`.
  Upload to R2 with ContentType (mime from extension map — html, htm, md, txt, json, csv, pdf, png, jpg,
  jpeg, gif, webp, svg, mp4, webm, mov, mp3, wav, zip, gz; fallback application/octet-stream),
  ContentDisposition `inline; filename="..."` (attachment for zip/gz/octet-stream).
- Response 201: { url, id, name, sha256, bytes, mime, deduped:false }
  where url = `${PUBLIC_BASE_URL}/f/${id}/${encodeURIComponent(safeName)}`.
- Insert DB row only after successful R2 PUT.

## GET /v1/files/:id — metadata JSON (auth required). Also accepts ?sha256=<hex> at /v1/files.
## GET /v1/me — token name, expiry, usage in each window vs limits, lifetime totals.
## GET /healthz — {ok:true}, no auth.

## Admin UI (/admin/*)
- Cookie session; login form posts ADMIN_PASSWORD; HttpOnly cookie, random session token kept in memory.
- Pages: 
  - /admin — stats (total files, total bytes, uploads last 24h, per-token table) + recent uploads
  - /admin/tokens — list (name, created, expires, revoked, usage), mint form (name, expiry days,
    optional quotas) → shows the full token ONCE after creation, revoke button (POST)
  - /admin/files — paginated table, search by name/sha/id, copy-URL, delete button (POST; deletes R2
    object then row). Deletes need a confirm step server-side (POST with confirm=1 param from a form).
- Plain, clean styling in a single inline <style>. No external assets (tailnet only anyway).

## CLI: `npm run mint -- --name laptop-agent [--days 30]`
Prints a fresh token. Same code path as admin mint (src/tokens.ts).

## Layout
```
src/
  index.ts        — entrypoint: config, migrate, serve
  config.ts
  db.ts           — open db, migrations
  tokens.ts       — mint/verify/revoke, usage queries, rate-limit check
  upload.ts       — streaming multipart handling, sha256, temp files
  r2.ts           — s3 client, put/delete
  mime.ts
  routes/api.ts
  routes/admin.tsx
scripts/mint.ts
test/             — unit tests: mime map, name sanitize, token verify, rate-limit window math (use in-memory sqlite)
Dockerfile        — multi-stage, node:22-bookworm-slim, prod deps only, runs as non-root uid 1001, VOLUME /data
docker-compose.yml— service `privateeyes`, env_file .env, ports "${BIND_HOST:-127.0.0.1}:8790:8790", volume ./data:/data, restart unless-stopped
.env.example
README.md         — quickstart, curl example, deploy notes
```

## Non-goals (v1)
No public listing, no ranges/resumable uploads, no auth on GET (public-by-URL), no TTL/expiry of files.
