#!/usr/bin/env bash
# Put the app behind HTTPS with an automatic, free certificate.
#   scripts/enable-https.sh                    -> uses a free name for this server's IP (no domain needed)
#   scripts/enable-https.sh chat.example.com   -> uses your own domain (point its DNS A record at this server first)
set -euo pipefail
cd "$(dirname "$0")/.."

domain="${1:-}"
if [ -z "$domain" ]; then
  ip=$(curl -fsS -4 https://api.ipify.org || curl -fsS -4 https://ifconfig.me)
  domain="${ip//./-}.sslip.io"   # e.g. 72-60-194-113.sslip.io resolves to 72.60.194.113
fi

cat > .env <<ENV
# Written by scripts/enable-https.sh. Delete this file and run "docker compose up -d" to go back to plain HTTP.
COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml
DOMAIN=$domain
COOKIE_SECURE=true
TRUST_PROXY=1
APP_BIND=127.0.0.1
ENV

# Open the web ports if this server uses ufw. (Hostinger's own firewall, if enabled, is set in hPanel.)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

docker compose up -d --build
echo
echo "HTTPS is being set up for: https://$domain"
echo "The certificate usually takes under a minute. If the page does not load, check: docker compose logs caddy"
