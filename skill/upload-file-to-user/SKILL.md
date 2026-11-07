---
name: upload-file-to-user
description: Use this when you want to upload a file to send to the user, get a sharable public URL.
---

Run: `./pe-upload <file> [custom-name]` (script is in this skill's directory; also installed as `pe-upload` on PATH). It prints a public URL — share that with the user.

Token: `PRIVATEEYES_TOKEN` env, else the file `~/.config/privateeyes/token` (respects `XDG_CONFIG_HOME`). If neither is set it exits 1 with a "no token" message — tell the user instead of retrying.

Server: `PRIVATEEYES_URL` (legacy `PRIVATEEYES_HOST`), else `~/.config/privateeyes/url`, else `http://ubuntu-app-prod:8790` (needs Tailscale).

Exit codes: 0 printed URL · 1 missing token/file, server unreachable, or HTTP error (details on stderr) · 2 usage. Identical files return the same URL. Max 100 MB.
