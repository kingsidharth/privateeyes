# privateeyes

Tailnet-gated file drop. Agents on the Tailscale network upload a file, get back a public
unguessable URL on `https://privateeyes.xperiments.app` (Cloudflare R2 + CDN).

```sh
curl -sF file=@plan.html -H "Authorization: Bearer $PRIVATEEYES_TOKEN" \
  http://ubuntu-app-prod:8790/v1/upload
# → { "url": "https://privateeyes.xperiments.app/f/Vq3xK9mA2rTe/plan.html", "deduped": false, ... }
```

Same file twice → same URL (sha256 dedupe). Max 100 MB. HTML renders inline; the public
origin carries no cookies or auth — never serve anything privileged from it.

## Endpoints (all tailnet-only except the CDN)
- `POST /v1/upload` — multipart `file` (+ optional `name`)
- `GET /v1/me` — quota/window usage · `GET /v1/files/:id` — metadata · `GET /healthz`
- `/admin` — token mint/revoke, file browse/delete, stats (cookie login, `ADMIN_PASSWORD`)

## Dev (Bun locally, Node 22 in prod)
```sh
bun install
cp .env.example .env       # fill R2 creds
bun run dev                # or: bun run test / build / mint -- --name my-agent
```
Prod container stays on Node 22 (better-sqlite3 native addon; boring and known-good).

## Deploy (Hetzner box, `sid@ubuntu-app-prod`)
```sh
rsync -a --exclude node_modules --exclude data --exclude .env . sid@ubuntu-app-prod:~/privateeyes/app/
ssh sid@ubuntu-app-prod 'cd ~/privateeyes/app && docker compose up -d --build'
```
`~/privateeyes/.env` on the box holds the real secrets (mirror kept locally as
gitignored `.env.production`). `BIND_HOST=100.107.41.112` publishes the port on the
Tailscale interface only — the upload API does not exist off the tailnet.

## Agent skill
Symlink `skill/upload-file-to-user` → `~/.agents/skills/upload-file-to-user`.
Agents set `PRIVATEEYES_TOKEN` and run `pe-upload <file>`.

## Rate limits (per token, sliding windows)
200 uploads / 2 GB per 8 h · 500 uploads / 5 GB per 24 h · optional lifetime quotas ·
30-day default token expiry, instant revoke. Tokens stored as sha256 only.
