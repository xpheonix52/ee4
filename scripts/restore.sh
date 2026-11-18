#!/usr/bin/env bash
# Restore a backup archive into this server (or a brand-new one). Usage: scripts/restore.sh <backup.tar.gz>
# Replaces the current database and WhatsApp logins with the ones in the archive.
set -euo pipefail
[ -f "${1:-}" ] || { echo "Usage: $0 <backup.tar.gz>"; exit 1; }
archive="$(realpath "$1")"
cd "$(dirname "$0")/.."
read -r -p "This replaces the current data with $archive. Type yes to continue: " ok
[ "$ok" = "yes" ] || exit 1
docker compose down
docker compose run --rm --no-deps -v "$archive":/restore.tar.gz:ro --entrypoint sh switchboard \
  -c 'rm -f /data/switchboard.db-wal /data/switchboard.db-shm && tar -xzf /restore.tar.gz -C /data'
docker compose up -d
echo "Restored. Open the app and check your chats."
