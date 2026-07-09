#!/bin/bash
# Wiznerd — Full server setup script
# Run as root on a fresh Ubuntu 24.04 DigitalOcean droplet
# Usage: bash server-setup.sh
set -e

echo ""
echo "========================================"
echo "  Wiznerd Server Setup — wiznerd.fun"
echo "========================================"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/9] Installing system packages..."
apt update -qq && apt upgrade -y -qq
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt install -y nodejs build-essential git nginx certbot python3-certbot-nginx redis-server > /dev/null
npm install -g pm2 > /dev/null
systemctl enable redis-server
systemctl start redis-server
echo "      Node $(node -v) · npm $(npm -v) · Redis $(redis-cli ping)"

# ── 2. Clone repos ────────────────────────────────────────────────────────────
echo "[2/9] Cloning repositories..."
mkdir -p /opt/wiznerd
cd /opt/wiznerd
if [ ! -d "Wiznerd" ]; then
  git clone https://github.com/purrdex/Wiznerd.git
else
  git -C Wiznerd pull --ff-only
fi
if [ ! -d "Wiznerd-proxy" ]; then
  git clone https://github.com/purrdex/Wiznerd-proxy.git
else
  git -C Wiznerd-proxy pull --ff-only
fi
echo "      Done."

# ── 3. Install dependencies ───────────────────────────────────────────────────
echo "[3/9] Installing npm dependencies..."
cd /opt/wiznerd/Wiznerd && npm ci --silent
cd /opt/wiznerd/Wiznerd/server && npm ci --silent
cd /opt/wiznerd/Wiznerd-proxy && npm ci --silent
echo "      Done."

# ── 4. Write .env ─────────────────────────────────────────────────────────────
echo "[4/9] Writing .env..."
cat > /opt/wiznerd/Wiznerd/.env << 'ENVEOF'
SUPABASE_URL=https://eigmggwmktiugfgkdtri.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpZ21nZ3dta3RpdWdmZ2tkdHJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMDY3ODgsImV4cCI6MjA4NjU4Mjc4OH0.GbDo8xq5Pa8So8AV66mQ-AkIEZuzSOC3WVUThS2KfWQ
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpZ21nZ3dta3RpdWdmZ2tkdHJpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTAwNjc4OCwiZXhwIjoyMDg2NTgyNzg4fQ.C9YS3tQ9KtQBJJN04yq-Onb-WZW4hDB0OpYmDLqoNhM
NFT_STORAGE_KEY=
REDIS_URL=redis://localhost:6379
PINATA_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI2NWUyMGIxNy04NzU4LTQ2ODUtOTBkYS1kMzJlMjIyNzBlYjMiLCJlbWFpbCI6ImJfc3RyYXViQHltYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaW5fcG9saWN5Ijp7InJlZ2lvbnMiOlt7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6IkZSQTEifSx7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6Ik5ZQzEifV0sInZlcnNpb24iOjF9LCJtZmFfZW5hYmxlZCI6ZmFsc2UsInN0YXR1cyI6IkFDVElWRSJ9LCJhdXRoZW50aWNhdGlvblR5cGUiOiJzY29wZWRLZXkiLCJzY29wZWRLZXlLZXkiOiIxNmZjMDM1MGM1ZjE0YjNiMjRlNCIsInNjb3BlZEtleVNlY3JldCI6IjllNjg0NGIxMGI1NTA4ZDlhZDQyMjJiZjFkNTcxNGE0ZDU1MzJkNDMwNDM5YjlkZDFiNjJiNzYxYzEyODc0MTYiLCJleHAiOjE4MTQxODg2NjZ9.J6QVW6QJkPw7I8T1DCBN5fdwDV2PDiEepSJP6zNLzb4
PINATASECRET=9e6844b10b5508d9ad4222bf1d5714a4d5532d430439b9dd1b62b761c1287416
MINTER_DID=did:chia:19vw9zz7uzu0gh3r3t7am6zt7gw4yc23k56lt9w2y9vfvs3eefy7scv4mmz
MINTER_NFT_WALLET_ID=4
PROFILE_OWNER_ADDRESS=xch1vcthngy6a69r93vr9grauj6wm3dpf54z6u2vkzzjmwqpahpjdklq45hjkd
VITE_SUPABASE_URL=https://eigmggwmktiugfgkdtri.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpZ21nZ3dta3RpdWdmZ2tkdHJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMDY3ODgsImV4cCI6MjA4NjU4Mjc4OH0.GbDo8xq5Pa8So8AV66mQ-AkIEZuzSOC3WVUThS2KfWQ
VITE_API_URL=https://wiznerd.fun
FRONTEND_ORIGIN=https://wiznerd.fun
PROXY_URL=http://localhost:3001
API_PORT=3002
ENVEOF
chmod 600 /opt/wiznerd/Wiznerd/.env
echo "      Done."

# ── 5. Build frontend ─────────────────────────────────────────────────────────
echo "[5/9] Building frontend..."
cd /opt/wiznerd/Wiznerd
npm run build
echo "      Done — dist/ created."

# ── 6. PM2 ecosystem config ───────────────────────────────────────────────────
echo "[6/9] Writing PM2 ecosystem config..."
cat > /opt/wiznerd/ecosystem.config.js << 'ECOSEOF'
module.exports = {
  apps: [
    {
      name: 'wiznerd-api',
      script: '/opt/wiznerd/Wiznerd/server/index.js',
      cwd: '/opt/wiznerd/Wiznerd/server',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
    },
    {
      name: 'wiznerd-proxy',
      script: '/opt/wiznerd/Wiznerd-proxy/index.js',
      cwd: '/opt/wiznerd/Wiznerd-proxy',
      env: {
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://wiznerd.fun',
        CHIA_NODE_HOST: '174.59.7.200',
        CHIA_ROOT: '/opt/wiznerd/chia-home',
        HOME: '/opt/wiznerd/chia-home',
      },
      instances: 1,
      autorestart: true,
    },
  ],
};
ECOSEOF

cd /opt/wiznerd
pm2 start ecosystem.config.js
pm2 save
# Register PM2 to start on boot
pm2 startup systemd -u root --hp /root 2>/dev/null || true
systemctl enable pm2-root 2>/dev/null || true
echo "      PM2 started."

# ── 7. Nginx config ───────────────────────────────────────────────────────────
echo "[7/9] Configuring nginx..."
cat > /etc/nginx/sites-available/wiznerd << 'NGINXEOF'
server {
    listen 80;
    server_name wiznerd.fun www.wiznerd.fun;

    # Static frontend
    root /opt/wiznerd/Wiznerd/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

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

    location /ws {
        proxy_pass         http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_read_timeout 3600s;
    }

    location /proxy/ {
        rewrite            ^/proxy/(.*)$ /$1 break;
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
}
NGINXEOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/wiznerd /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
echo "      Nginx configured."

# ── 8. SSL certificate ────────────────────────────────────────────────────────
echo "[8/9] Obtaining SSL certificate..."
certbot --nginx -d wiznerd.fun -d www.wiznerd.fun --non-interactive --agree-tos -m devautistic@gmail.com
echo "      SSL done."

# ── 9. Nightly Dexie sync cron ───────────────────────────────────────────────
echo "[9/9] Setting up nightly Dexie sync cron..."
cat > /opt/wiznerd/dexie-sync.sh << 'CRONEOF'
#!/bin/bash
SINCE=$(date -d "yesterday" +%Y-%m-%d)
cd /opt/wiznerd/Wiznerd
echo "[dexie-sync] $(date) — syncing trades since $SINCE"
node server/dexie-backfill.js --all --since "$SINCE"
echo "[dexie-sync] done"
CRONEOF
chmod +x /opt/wiznerd/dexie-sync.sh

cat > /opt/wiznerd/ownership-sync.sh << 'CRONEOF'
#!/bin/bash
cd /opt/wiznerd/Wiznerd
echo "[ownership-sync] $(date) — refreshing NFT ownership from MintGarden"
node server/nft-backfill.js --all --ownership
echo "[ownership-sync] done"
CRONEOF
chmod +x /opt/wiznerd/ownership-sync.sh

# 2 AM — Dexie trade data; 3 AM — ownership refresh
(crontab -l 2>/dev/null | grep -v dexie-sync | grep -v ownership-sync
 echo "0 2 * * * /opt/wiznerd/dexie-sync.sh >> /var/log/wiznerd-dexie.log 2>&1"
 echo "0 3 * * * /opt/wiznerd/ownership-sync.sh >> /var/log/wiznerd-ownership.log 2>&1"
) | crontab -
echo "      Crons set."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Setup complete!"
echo ""
echo "  Site:    https://wiznerd.fun"
echo "  PM2:     pm2 list"
echo "  Logs:    pm2 logs wiznerd-api"
echo ""
echo "  Remember to run the initial Dexie backfill:"
echo "  node /opt/wiznerd/Wiznerd/server/dexie-backfill.js --all"
echo "========================================"
echo ""
