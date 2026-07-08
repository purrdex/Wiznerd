#!/bin/bash
# Wiznerd — Bootstrap script (run from your HOME PC in Git Bash)
# Copies Chia certs to the server, then runs the full server setup.
# Usage: bash deploy/bootstrap.sh
set -e

SERVER="root@161.35.115.156"
SSH_KEY="$USERPROFILE/.ssh/wiznerd"
SSH_OPTS="-i $SSH_KEY"
SCP_OPTS="-i $SSH_KEY"
CERT_BASE="C:/Users/b_str/.chia/mainnet/config/ssl"

echo ""
echo "========================================"
echo "  Wiznerd Bootstrap — from home PC"
echo "========================================"
echo ""

# ── Copy Chia SSL certs ───────────────────────────────────────────────────────
echo "[1/3] Copying Chia SSL certs to server..."
ssh $SSH_OPTS "$SERVER" "mkdir -p /opt/wiznerd/chia-home/config/ssl/full_node /opt/wiznerd/chia-home/config/ssl/wallet"

scp $SCP_OPTS "$CERT_BASE/full_node/private_full_node.crt" "$SERVER:/opt/wiznerd/chia-home/config/ssl/full_node/"
scp $SCP_OPTS "$CERT_BASE/full_node/private_full_node.key" "$SERVER:/opt/wiznerd/chia-home/config/ssl/full_node/"
scp $SCP_OPTS "$CERT_BASE/wallet/private_wallet.crt"       "$SERVER:/opt/wiznerd/chia-home/config/ssl/wallet/"
scp $SCP_OPTS "$CERT_BASE/wallet/private_wallet.key"       "$SERVER:/opt/wiznerd/chia-home/config/ssl/wallet/"

ssh $SSH_OPTS "$SERVER" "chmod 600 /opt/wiznerd/chia-home/config/ssl/full_node/*.key /opt/wiznerd/chia-home/config/ssl/wallet/*.key"
echo "      Certs copied."

# ── Copy setup script ─────────────────────────────────────────────────────────
echo "[2/3] Uploading setup script..."
scp $SCP_OPTS "$(dirname "$0")/server-setup.sh" "$SERVER:/root/server-setup.sh"
ssh $SSH_OPTS "$SERVER" "chmod +x /root/server-setup.sh"
echo "      Uploaded."

# ── Run setup on server ───────────────────────────────────────────────────────
echo "[3/3] Running server setup (this will take a few minutes)..."
echo ""
ssh $SSH_OPTS "$SERVER" "bash /root/server-setup.sh"
