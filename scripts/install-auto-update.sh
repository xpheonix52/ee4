#!/usr/bin/env bash
# One-time setup on the server: check GitHub for new code every 5 minutes.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$dir/scripts/"*.sh
line="*/5 * * * * $dir/scripts/auto-update.sh >> /var/log/switchboard-update.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'scripts/auto-update.sh' ; echo "$line" ) | crontab -
echo "Auto-update installed. New code on GitHub goes live within about 5 minutes."
echo "Watch it with: tail -f /var/log/switchboard-update.log"
