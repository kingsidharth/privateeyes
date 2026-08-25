---
name: upload-file-to-user
description: Use this when you want to upload a file to send to the user, get a sharable public URL.
---

Run: `./pe-upload <file> [custom-name]` (script is in this skill's directory). It prints a public URL — share that with the user.

Needs `PRIVATEEYES_TOKEN` env (and Tailscale). Optional `PRIVATEEYES_HOST` overrides the endpoint. Identical files return the same URL. Max 100 MB.
