# Production Linux Deployment Guide

Deploying Wiznerd Wallet to a DigitalOcean droplet (Ubuntu 24.04, 2 CPU / 4 GB RAM).
Server IP: `161.35.115.156` — domain: `wiznerd.fun`

---

## Architecture Overview

```
Internet → nginx (80/443)
                ├── / → static files (Vite build)
                ├── /api/ → API server (port 3002)
                └── /proxy/ → Chia proxy (port 3001)

API server (3002)  → Supabase (cloud) + Redis (local)
Chia proxy (3001)  → Chia full node (8555) + wallet daemon (9256)
```

---

## 1. Server Requirements

- **OS**: Ubuntu 24.04 LTS
- **CPU**: 2 vCPU
- **RAM**: 4 GB (Chia node runs on home PC — not needed here)
- **Disk**: 50 GB SSD (no chain storage needed)
- **Ports open**: 22 (SSH), 80 (HTTP), 443 (HTTPS)

---

## 2. Install System Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Build tools (needed for @napi-rs/canvas prebuilt binaries)
sudo apt install -y build-essential git nginx certbot python3-certbot-nginx

# Redis
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# PM2 (process manager)
sudo npm install -g pm2

# Verify
node -v   # should be v20.x
npm -v
redis-cli ping   # should return PONG
```

---

## 3. Copy Chia SSL Certs from Home PC

The proxy on the cloud server needs the Chia SSL certificates to authenticate with your home node. The certs live on your Windows PC at:

```
C:\Users\b_str\.chia\mainnet\config\ssl\full_node\private_full_node.crt
C:\Users\b_str\.chia\mainnet\config\ssl\full_node\private_full_node.key
C:\Users\b_str\.chia\mainnet\config\ssl\wallet\private_wallet.crt
C:\Users\b_str\.chia\mainnet\config\ssl\wallet\private_wallet.key
```

Copy them to the server mirroring the Chia directory structure (run from Git Bash on your PC):

```bash
# Create the cert directory structure on the server
ssh root@161.35.115.156 "mkdir -p /opt/wiznerd/chia-home/config/ssl/full_node /opt/wiznerd/chia-home/config/ssl/wallet"

# Copy the certs
scp "C:/Users/b_str/.chia/mainnet/config/ssl/full_node/private_full_node.crt" root@161.35.115.156:/opt/wiznerd/chia-home/config/ssl/full_node/
scp "C:/Users/b_str/.chia/mainnet/config/ssl/full_node/private_full_node.key" root@161.35.115.156:/opt/wiznerd/chia-home/config/ssl/full_node/
scp "C:/Users/b_str/.chia/mainnet/config/ssl/wallet/private_wallet.crt" root@161.35.115.156:/opt/wiznerd/chia-home/config/ssl/wallet/
scp "C:/Users/b_str/.chia/mainnet/config/ssl/wallet/private_wallet.key" root@161.35.115.156:/opt/wiznerd/chia-home/config/ssl/wallet/

# Lock down key permissions
ssh root@161.35.115.156 "chmod 600 /opt/wiznerd/chia-home/config/ssl/full_node/*.key /opt/wiznerd/chia-home/config/ssl/wallet/*.key"
```

The proxy's PM2 config (section 7) sets `CHIA_ROOT: '/opt/wiznerd/chia-home'` so it reads certs from that directory.

> **Note**: If Chia ever regenerates its SSL certs, re-run the `scp` commands above and restart the proxy.

---

## 4. Deploy the Code

```bash
# Clone both repos into /opt
sudo mkdir -p /opt/wiznerd
sudo chown $USER:$USER /opt/wiznerd
cd /opt/wiznerd

git clone https://github.com/YOUR_ORG/chia-wallet.git
git clone https://github.com/YOUR_ORG/chia-proxy.git
```

### Install dependencies

```bash
# Frontend + API server
cd /opt/wiznerd/chia-wallet
npm ci

# API server (in server/ subdirectory)
cd /opt/wiznerd/chia-wallet/server
npm ci

# Proxy
cd /opt/wiznerd/chia-proxy
npm ci
```

---

## 5. Environment Variables

Create `/opt/wiznerd/chia-wallet/.env`:

```env
# Supabase (get from your Supabase project → Settings → API)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...

# NFT.storage (get from nft.storage)
NFT_STORAGE_KEY=your-nft-storage-key

# Redis (default: local Redis)
REDIS_URL=redis://localhost:6379

# API server port (default: 3002)
API_PORT=3002

# CORS: your production domain
FRONTEND_ORIGIN=https://wiznerd.fun

# Proxy URL (used by server to talk to the Chia proxy internally)
PROXY_URL=http://localhost:3001
```

Create `/opt/wiznerd/chia-proxy/.env` (or set via PM2 env):

```env
FRONTEND_ORIGIN=https://wiznerd.fun
# If Chia is running under a different user, override the cert path:
# CHIA_ROOT=/home/chia/.chia/mainnet
```

---

## 6. Build the Frontend

```bash
cd /opt/wiznerd/chia-wallet

# Set the public API URL (used by Vite at build time)
echo "VITE_API_URL=https://wiznerd.fun" >> .env

npm run build
# Output: dist/ (static files)
```

---

## 7. PM2 Process Configuration

Create `/opt/wiznerd/ecosystem.config.js`:

```js
module.exports = {
  apps: [
    {
      name: 'wiznerd-api',
      script: '/opt/wiznerd/chia-wallet/server/index.js',
      cwd: '/opt/wiznerd/chia-wallet/server',
      env: {
        NODE_ENV: 'production',
      },
      // PM2 will load /opt/wiznerd/chia-wallet/.env via dotenv inside server/index.js
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
    },
    {
      name: 'wiznerd-proxy',
      script: '/opt/wiznerd/chia-proxy/index.js',
      cwd: '/opt/wiznerd/chia-proxy',
      env: {
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://wiznerd.fun',
        CHIA_NODE_HOST: 'YOUR_HOME_PUBLIC_IP_OR_DDNS',  // e.g. 76.123.45.67 or myhome.duckdns.org
        CHIA_ROOT: '/opt/wiznerd/chia-home',             // cert directory copied from home PC (see step 3)
      },
      instances: 1,
      autorestart: true,
    },
  ],
};
```

Start everything:

```bash
cd /opt/wiznerd
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

Useful PM2 commands:
```bash
pm2 list              # status of all processes
pm2 logs wiznerd-api  # tail API logs
pm2 restart wiznerd-proxy
pm2 reload all        # zero-downtime reload
```

---

## 8. Nginx Configuration

Create `/etc/nginx/sites-available/wiznerd`:

```nginx
server {
    listen 80;
    server_name wiznerd.fun;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name wiznerd.fun;

    # SSL (filled in by certbot — run step 9 first)
    ssl_certificate     /etc/letsencrypt/live/wiznerd.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wiznerd.fun/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Static frontend (Vite build output)
    root /opt/wiznerd/chia-wallet/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API server
    location /api/ {
        proxy_pass         http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
        client_max_body_size 50M;
    }

    # WebSocket endpoint for realtime generation progress
    location /ws {
        proxy_pass         http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_read_timeout 3600s;
    }

    # Chia proxy (Chia node RPC bridge)
    location /proxy/ {
        rewrite            ^/proxy/(.*)$ /$1 break;
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/wiznerd /etc/nginx/sites-enabled/
sudo nginx -t          # verify config
sudo systemctl reload nginx
```

---

## 9. SSL Certificate (Let's Encrypt)

```bash
# Point your domain's A record to the server IP first, then:
sudo certbot --nginx -d wiznerd.fun

# Auto-renewal is set up automatically; verify with:
sudo certbot renew --dry-run
```

---

## 10. Frontend Environment Variable

The Vite build bakes `VITE_API_URL` into the static JS at build time. If you change your domain, rebuild:

```bash
cd /opt/wiznerd/chia-wallet
VITE_API_URL=https://wiznerd.fun npm run build
# Then reload nginx static files — no process restart needed
```

---

## 11. Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

Ports 3001, 3002, 6379 should remain **closed** to the internet (nginx proxies them internally).
Chia P2P port 8444 is not needed — the node runs on your home PC.

---

## 12. Nightly Dexie Trade Sync (Cron)

The trending scores and rankings are fed by `nft_transfers`. The Dexie backfill needs to run nightly to pull in the previous day's completed trades. The `--since` flag makes it exit early per collection once it hits data older than the cutoff, so it only fetches recent pages.

Create the sync script at `/opt/wiznerd/dexie-sync.sh`:

```bash
#!/bin/bash
set -e
SINCE=$(date -d "yesterday" +%Y-%m-%d)
cd /opt/wiznerd/chia-wallet
echo "[dexie-sync] $(date) — syncing trades since $SINCE"
node server/dexie-backfill.js --all --since "$SINCE" >> /var/log/wiznerd-dexie.log 2>&1
echo "[dexie-sync] done"
```

Make it executable:

```bash
chmod +x /opt/wiznerd/dexie-sync.sh
```

Add it to cron (runs at 2 AM every night):

```bash
crontab -e
```

Add this line:

```
0 2 * * * /opt/wiznerd/dexie-sync.sh >> /var/log/wiznerd-dexie.log 2>&1
```

Verify cron is set:

```bash
crontab -l
```

View logs:

```bash
tail -f /var/log/wiznerd-dexie.log
```

**First run after deploy** — backfill all history before the nightly cron takes over:

```bash
node /opt/wiznerd/chia-wallet/server/dexie-backfill.js --all
```

---

## 13. Deploy Updates

```bash
cd /opt/wiznerd/chia-wallet
git pull
npm ci
npm run build           # rebuild frontend
cd server && npm ci     # if server deps changed

# Restart API server (zero-downtime for API, instant for static files)
pm2 reload wiznerd-api
# Proxy only needs restart if its code changed:
pm2 restart wiznerd-proxy
```

---

## 14. Verify Everything Is Running

```bash
# Processes
pm2 list

# Redis
redis-cli ping

# API health check
curl http://localhost:3002/api/health

# Proxy health (should return JSON from Chia node)
curl -s http://localhost:3001/get_blockchain_state -X POST -H "Content-Type: application/json" -d '{}' | head -c 100

# Nginx
sudo nginx -t && systemctl status nginx

# SSL
curl -I https://wiznerd.fun
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Proxy crashes on start | Chia SSL cert not found | Check `HOME` env var points to the Chia user's home; verify cert paths exist |
| API 500 on Supabase calls | Wrong `SUPABASE_SERVICE_KEY` | Re-copy from Supabase Settings → API → `service_role` key |
| Generation jobs stuck | Redis not running or `REDIS_URL` wrong | `redis-cli ping`; check PM2 env |
| NFT images not loading | `output` bucket not public | Supabase Storage → `output` → Policies → allow public reads |
| `/api/` returns 502 | API server not running | `pm2 logs wiznerd-api` |
| Chia wallet RPC fails | Wallet daemon not running on home PC | Start it: `chia start wallet` on your home PC |
| Proxy can't reach Chia node | Wrong `CHIA_NODE_HOST` or port not forwarded | Verify port 8555/9256 forwarded on home router; check `CHIA_NODE_HOST` in PM2 config |
