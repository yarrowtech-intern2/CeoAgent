# CEO Agent OS VPS Deployment Guide

This guide deploys the web server version of CEO Agent OS on an Ubuntu VPS.
It does not deploy the Electron desktop shell. The VPS runs the compiled
Node.js/Express server from `dist/server/index.js`, serves the UI from
`dist/server/public`, and stores runtime data in a persistent directory.




## Update code change t inflict in vps
cd /var/www/CeoAgent
git status
git pull
npm ci
npm run build
sudo systemctl restart ceoagent
sudo systemctl status ceoagent --no-pager


-----------------------------------------------------------------------------------
## check projects
# 1. Is a service running the app?
systemctl list-units --type=service | grep -i -E "ceo|node|agent"

# 2. Is it running under PM2 or Docker?
pm2 list 2>/dev/null
docker ps 2>/dev/null

# 3. Which process is listening, and from which folder?
ss -tlnp | grep -E "node|:3000"
ls -l /proc/$(pgrep -f "dist/server/index.js\|tsx" | head -1)/cwd 2>/dev/null

# 4. Search the disk for the project
find / -name "orchestrator.*" -not -path "*/node_modules/*" 2>/dev/null | head
ls ~ /var/www /srv /home 2>/dev/null

----------------------------------------------------------------------------------






## 1. What You Need

- Ubuntu 22.04 or 24.04 VPS
- Domain or subdomain pointed to the VPS, for example `ceo.example.com`
- SSH access with a sudo user
- Node.js 22 LTS
- npm
- Nginx
- Certbot for HTTPS
- Supabase project with Email authentication enabled
- Your application credentials, at minimum `ANTHROPIC_API_KEY`

Important security note: this app uses Supabase login for normal UI/API
access. Do not expose the Node port directly; keep it behind Nginx and HTTPS.

## 2. Prepare the VPS

SSH into the server:

```bash
ssh deploy@your-vps-ip
```

Update packages:

```bash
sudo apt update
sudo apt upgrade -y
```

Install common tools:

```bash
sudo apt install -y curl git nginx ufw
```

Install Node.js 22 LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 3. Create App Directories

Use `/opt/ceo-agent-os` for the source/build and `/var/lib/ceo-agent-os` for
persistent runtime data.

```bash
sudo mkdir -p /opt/ceo-agent-os
sudo mkdir -p /var/lib/ceo-agent-os
sudo chown -R deploy:deploy /opt/ceo-agent-os /var/lib/ceo-agent-os
```

Runtime data written under `/var/lib/ceo-agent-os` includes:

- `data/tenants.json`
- `orgs/<organization-id>/data/runs.json`
- `orgs/<organization-id>/data/settings.json`
- OAuth token files such as `gmail-token.json`, `instagram-token.json`, and
  `linkedin-token.json`
- `orgs/<organization-id>/workspace/`
- `orgs/<organization-id>/deliverables/`

Back up `/var/lib/ceo-agent-os` regularly.

## 4. Upload Or Clone The Project

If the project is in Git:

```bash
cd /opt/ceo-agent-os
git clone <your-repo-url> .
```

If you are copying from your local machine:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .git \
  ./ deploy@your-vps-ip:/opt/ceo-agent-os/
```

Run the following on the VPS after the files are present:

```bash
cd /opt/ceo-agent-os
npm ci
npm run build
```

The build command runs TypeScript compilation and copies static assets from
`src/server/public` to `dist/server/public`.

## 5. Configure Environment Variables

Create an environment file:

```bash
sudo nano /etc/ceo-agent-os.env
```

Start with this template:

```ini
NODE_ENV=production
PORT=3000
CEO_AGENT_DATA_DIR=/var/lib/ceo-agent-os

# Required for signup/login
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=replace_me

# Required for agent runs
ANTHROPIC_API_KEY=replace_me

# Recommended for external automation endpoints
AUTOMATION_API_KEY=replace_with_a_long_random_secret

# Optional integrations
LINEAR_API_KEY=
LINEAR_TEAM_ID=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://ceo.example.com/auth/gmail/callback

META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=https://ceo.example.com/auth/instagram/callback

LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=https://ceo.example.com/auth/linkedin/callback

ZERNIO_API_KEY=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=

OPENAI_API_KEY=

REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
REDDIT_ALLOWED_SUBREDDITS=

WEBHOOK_URL=
N8N_WORKFLOWS=
```

Protect the file:

```bash
sudo chown root:root /etc/ceo-agent-os.env
sudo chmod 600 /etc/ceo-agent-os.env
```

Notes:

- Replace `https://ceo.example.com` with your real domain.
- In Supabase, enable Authentication -> Providers -> Email. If email
  confirmation is enabled, users must confirm their email before signing in.
- OAuth redirect URLs must exactly match the URLs configured in Google, Meta,
  and LinkedIn developer dashboards.
- The app can also save many credentials from the Settings screen into
  `/var/lib/ceo-agent-os/orgs/<organization-id>/data/settings.json`.
- `N8N_WORKFLOWS` must be valid JSON, for example:

```ini
N8N_WORKFLOWS={"notify_sales":"https://n8n.example.com/webhook/sales"}
```

Generate a strong automation key:

```bash
openssl rand -hex 32
```

### Database, limits and proxy settings

```ini
# Postgres storage (recommended for the VPS). Supabase: Project Settings ->
# Database -> Connection string (use the Session pooler URI). The table is
# created automatically on first start, and existing JSON files under
# data/ and orgs/ are imported the first time each one is read.
DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres
# DATABASE_SSL=false   # only for a local Postgres without TLS

# Behind Nginx — required so rate limits see real client IPs.
TRUST_PROXY=1

# Guardrails (per organization, per UTC day; 0 = no limit)
MAX_RUNS_PER_DAY=200
MAX_COST_USD_PER_DAY=20
MAX_OUTBOUND_ACTIONS_PER_DAY=100
# OUTBOUND_ACTIONS_ENABLED=false   # kill switch: block every send/post/DM

# Optional rate-limit overrides (per IP, per minute)
# RATE_LIMIT_API_PER_MIN=600
# RATE_LIMIT_RUNS_PER_MIN=20
```

Run only one server process per database: documents are cached in memory,
so two instances would overwrite each other's changes. Uploaded files and
generated documents (`workspace/`, `deliverables/`) still live on disk and
need the backups described below.

Today's usage against these limits is at `GET /api/guardrails`. Every
outbound action (allowed, blocked or failed) is recorded at `GET /api/audit-log`.
`GET /healthz` returns `{ "ok": true }` for uptime checks.

## 6. Test The App Manually

Run the compiled server once:

```bash
cd /opt/ceo-agent-os
set -a
. /etc/ceo-agent-os.env
set +a
node dist/server/index.js
```

In another SSH session:

```bash
curl -i http://127.0.0.1:3000/api/auth/config
```

You should receive `HTTP/1.1 200 OK` and JSON showing Supabase auth is
enabled. Protected API routes such as `/api/departments` should return `401`
until a browser user signs in. Stop the manual server with `Ctrl+C`.

## 7. Run With systemd

Create a dedicated service:

```bash
sudo nano /etc/systemd/system/ceo-agent-os.service
```

Paste:

```ini
[Unit]
Description=CEO Agent OS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/ceo-agent-os
EnvironmentFile=/etc/ceo-agent-os.env
ExecStart=/usr/bin/node /opt/ceo-agent-os/dist/server/index.js
Restart=always
RestartSec=5

# Basic hardening. Keep write access available through CEO_AGENT_DATA_DIR.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/ceo-agent-os

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ceo-agent-os
sudo systemctl start ceo-agent-os
sudo systemctl status ceo-agent-os
```

View logs:

```bash
journalctl -u ceo-agent-os -f
```

## 8. Put Nginx In Front

Create the Nginx site:

```bash
sudo nano /etc/nginx/sites-available/ceo-agent-os
```

Paste and replace `ceo.example.com`:

The Node app now handles Supabase login itself. Keep Nginx as a reverse proxy
and TLS endpoint; only the tenant-specific WhatsApp webhook path is public for
Meta callbacks.

```nginx
server {
    listen 80;
    server_name ceo.example.com;

    # For multi-tenant WhatsApp auto-reply, configure Meta with:
    # https://ceo.example.com/webhook/whatsapp/<organization-id>
    location /webhook/whatsapp/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Needed for long-running server-sent event streams.
        proxy_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/ceo-agent-os /etc/nginx/sites-enabled/ceo-agent-os
sudo nginx -t
sudo systemctl reload nginx
```

## 9. Enable HTTPS

Open the firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Install Certbot and request a certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ceo.example.com
```

Confirm renewal is configured:

```bash
sudo certbot renew --dry-run
```

## 10. Configure OAuth Providers

If you use Gmail, Instagram, or LinkedIn, register these callback URLs with
the provider exactly:

```text
https://ceo.example.com/auth/gmail/callback
https://ceo.example.com/auth/instagram/callback
https://ceo.example.com/auth/linkedin/callback
```

Then set the matching variables in `/etc/ceo-agent-os.env`:

```ini
GOOGLE_REDIRECT_URI=https://ceo.example.com/auth/gmail/callback
META_REDIRECT_URI=https://ceo.example.com/auth/instagram/callback
LINKEDIN_REDIRECT_URI=https://ceo.example.com/auth/linkedin/callback
```

Restart after environment changes:

```bash
sudo systemctl restart ceo-agent-os
```

Open `https://ceo.example.com`, go to Accounts, and connect each provider.

## 11. Verify Production

Check the app:

```bash
curl -I https://ceo.example.com
```

Open `https://ceo.example.com` in a browser, create an account, and sign in.
The first successful login creates an organization workspace under
`/var/lib/ceo-agent-os/orgs/<organization-id>`. The organization id is shown
in the Settings view after login.

Check automation endpoint protection:

```bash
curl -i -X POST https://ceo.example.com/api/automation/runs \
  -H 'Content-Type: application/json' \
  -H 'X-Organization-Id: organization_id_from_signed_in_profile' \
  -d '{"goal":"test"}'
```

The request should fail without `X-API-Key`. It should also fail if
`X-Organization-Id` is missing or unknown.

Test with the key:

```bash
curl -i -X POST https://ceo.example.com/api/automation/runs \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your_automation_key' \
  -H 'X-Organization-Id: organization_id_from_signed_in_profile' \
  -d '{"goal":"Say hello and stop."}'
```

## 12. Updating The Deployment

For Git-based deployments:

```bash
cd /opt/ceo-agent-os
git pull
npm ci
npm run build
sudo systemctl restart ceo-agent-os
sudo systemctl status ceo-agent-os
```

For copied deployments, upload the new files, then run:

```bash
cd /opt/ceo-agent-os
npm ci
npm run build
sudo systemctl restart ceo-agent-os
```

## 13. Backups

Back up the persistent data directory:

```bash
sudo tar -czf /tmp/ceo-agent-os-backup-$(date +%F).tgz /var/lib/ceo-agent-os
```

Copy the archive to external storage. At minimum, protect:

- `/var/lib/ceo-agent-os/data/tenants.json`
- `/var/lib/ceo-agent-os/orgs/<organization-id>/data/settings.json`
- `/var/lib/ceo-agent-os/orgs/<organization-id>/data/runs.json`
- `/var/lib/ceo-agent-os/orgs/<organization-id>/data/*-token.json`
- `/var/lib/ceo-agent-os/orgs/<organization-id>/workspace`
- `/var/lib/ceo-agent-os/orgs/<organization-id>/deliverables`
- `/etc/ceo-agent-os.env`

## 14. Troubleshooting

Check service logs:

```bash
journalctl -u ceo-agent-os -n 200 --no-pager
```

Check whether the app is listening:

```bash
ss -ltnp | grep 3000
```

Check Nginx:

```bash
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
```

Common issues:

- `ANTHROPIC_API_KEY is not set`: add it to `/etc/ceo-agent-os.env` and
  restart the service.
- OAuth says redirect URI mismatch: update the provider dashboard and the
  matching `*_REDIRECT_URI` environment variable so they are identical.
- The UI loads but runs fail: inspect `journalctl -u ceo-agent-os -f` while
  starting a run.
- Documents or run history disappear after restart: confirm
  `CEO_AGENT_DATA_DIR=/var/lib/ceo-agent-os` is set and that the `deploy` user
  can write there.
- Long runs disconnect in the browser: confirm `proxy_buffering off` and long
  proxy timeouts are present in the Nginx config.

## 15. Minimal Command Summary

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo mkdir -p /opt/ceo-agent-os /var/lib/ceo-agent-os
sudo chown -R deploy:deploy /opt/ceo-agent-os /var/lib/ceo-agent-os
cd /opt/ceo-agent-os
git clone <your-repo-url> .
npm ci
npm run build
sudo nano /etc/ceo-agent-os.env
sudo nano /etc/systemd/system/ceo-agent-os.service
sudo systemctl daemon-reload
sudo systemctl enable --now ceo-agent-os
sudo nano /etc/nginx/sites-available/ceo-agent-os
sudo ln -s /etc/nginx/sites-available/ceo-agent-os /etc/nginx/sites-enabled/ceo-agent-os
sudo nginx -t
sudo systemctl reload nginx
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ceo.example.com
```
