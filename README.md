# privateeyes

Tailnet-gated file drop for agents. It accepts authenticated multipart uploads and stores files in Cloudflare R2, returning public unguessable URLs.

## Quickstart

Copy `.env.example` to `.env`, set the R2 credentials and `ADMIN_PASSWORD`, then run:

```sh
npm install
npm run mint -- --name laptop-agent --days 30
npm run dev
```

Upload with:

```sh
curl -F file=@report.pdf -H "Authorization: Bearer pe_..." http://127.0.0.1:8790/v1/upload
```

`GET /healthz` is unauthenticated. `/v1/files/:id`, `/v1/files?sha256=...`, `/v1/me`, and uploads require the bearer token. Admin pages are under `/admin` and use the configured password.

## Deploy

Use `docker compose up -d --build` with `.env` and persistent `./data`. Put the service behind Tailscale access controls. R2 credentials are read at startup; never expose them to clients.
