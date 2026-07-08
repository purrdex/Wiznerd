#!/bin/bash
# Run from Git Bash: bash deploy/finish-setup.sh
set -e
SERVER="root@161.35.115.156"
KEY="$USERPROFILE/.ssh/wiznerd"

ssh -i "$KEY" "$SERVER" 'bash -s' << '"REMOTE"'

# Nginx
cat > /etc/nginx/sites-available/wiznerd << 'NGINXEOF'
server {
    listen 80;
    server_name wiznerd.fun www.wiznerd.fun;
    root /opt/wiznerd/Wiznerd/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /api/ {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
        client_max_body_size 50M;
    }
    location /ws {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_read_timeout 3600s;
    }
    location /proxy/ {
        rewrite ^/proxy/(.*)$ /$1 break;
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 30s;
    }
}
NGINXEOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/wiznerd /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
echo "[nginx] done"

# SSL
certbot --nginx -d wiznerd.fun -d www.wiznerd.fun --non-interactive --agree-tos -m devautistic@gmail.com
echo "[ssl] done"

# Dexie cron
cat > /opt/wiznerd/dexie-sync.sh << 'CRONEOF'
#!/bin/bash
SINCE=$(date -d "yesterday" +%Y-%m-%d)
cd /opt/wiznerd/Wiznerd
echo "[dexie-sync] $(date) - syncing trades since $SINCE"
node server/dexie-backfill.js --all --since "$SINCE"
CRONEOF
chmod +x /opt/wiznerd/dexie-sync.sh
(crontab -l 2>/dev/null | grep -v dexie-sync; echo "0 2 * * * /opt/wiznerd/dexie-sync.sh >> /var/log/wiznerd-dexie.log 2>&1") | crontab -
echo "[cron] done"

echo ""
echo "All done! https://wiznerd.fun"
"REMOTE"
