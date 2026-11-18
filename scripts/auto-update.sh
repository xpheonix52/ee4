#!/usr/bin/env bash
# Keeps this server on the newest code from GitHub. Run it from cron every few minutes:
# it does nothing unless the branch has new commits, then rebuilds and restarts the app.
# Chats, WhatsApp logins and settings live in the Docker volume and are untouched by updates.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/switchboard-update.lock
flock -n 9 || exit 0   # an update is already running

branch=$(git rev-parse --abbrev-ref HEAD)
git fetch --quiet origin "$branch"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then exit 0; fi

echo "$(date -Is) updating $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/$branch")"
previous=$(git rev-parse HEAD)
git merge --ff-only --quiet "origin/$branch"
if docker compose up -d --build; then
  echo "$(date -Is) update finished"
else
  # A broken build must not leave the checkout ahead of what is running: go back and try again next time.
  echo "$(date -Is) BUILD FAILED, staying on $(git rev-parse --short "$previous")"
  git reset --hard --quiet "$previous"
  exit 1
fi
