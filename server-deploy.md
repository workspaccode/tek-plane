---
name: server-deploy
description: Where tek-plane (6dx) is deployed and how the production server is set up
metadata:
  node_type: memory
  type: project
  originSessionId: a92f83df-64db-4777-9cd1-09538a97c1a9
  modified: 2026-11-26T07:28:11.092Z
---

Production server: Fedora 39 VPS 93.127.135.78 (SHARED: also hosts dsimu.resc.sa, dsimu-eng.resc.sa, inverter.resc.sa). App at /srv/tek-plane, live at https://6dx.resc.sa since 2026-11-26 (nginx conf /etc/nginx/conf.d/6dx.conf + snippets/6dx-proxy.conf; auth endpoints rate-limited; /ws not logged because the token is in the query string; uvicorn runs with --no-access-log). Pending as of 2026-11-26: TEKPLANE_ADMIN_EMAILS, Google/GitHub callback URLs, SSH password lockdown (needs user OK — shared server).

Access: Claude uses its own key `ssh -i ~/.ssh/tekplane_deploy -o IdentitiesOnly=yes root@93.127.135.78` (the termius MCP can't read this host's login because Termius recorded an earlier password-typed session).

Layout:
- system user `tekplane`; venv /var/lib/tekplane/venv built with python3.12 + `pip install --require-hashes -r /srv/tek-plane/requirements.lock.txt` (generated locally by `uv export --frozen --no-dev --no-emit-project`; Fedora 39's uv 0.4.25 can't read uv.lock revision 3)
- systemd `tekplane.service`, uvicorn 127.0.0.1:8000, hardened, only data/ writable
- nginx (NOT Caddy) fronts everything; 00-default-block.conf returns 444 for bare IP on purpose — never change it. Sites use the wildcard cert /etc/nginx/ssl/resc.sa/ and Cloudflare (real IP config lives in dsimu.conf).
- firewalld + fail2ban (sshd jail) already existed. Backups in /root/backups.

**Why:** Shared server with other production apps — changes must not touch them.
**How to apply:** Code changes: rsync backend/ frontend/ then `systemctl restart tekplane`; dep changes: re-export requirements and re-run pip. Always `nginx -t` before reload. Related: [[termius-mcp]]
