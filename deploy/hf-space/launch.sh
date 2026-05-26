#!/bin/bash
set -e

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ALLOWED_IDS="${TELEGRAM_ALLOWED_IDS:-[]}"
PROXY_URL="${PROXY_URL:-}"
HF_TOKEN="${HF_TOKEN:-}"
DATASET_ID="${DATASET_ID:-}"

if [ -z "$BOT_TOKEN" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN secret is not set"
  exit 1
fi

echo "Generating headless-gateway config from secrets..."
cat > config/headless-gateway.config.json <<CONF
{
  "headless": {
    "host": "0.0.0.0",
    "port": 8001,
    "dataRoot": "./data-headless"
  },
  "telegram": {
    "enabled": true,
    "botToken": "${BOT_TOKEN}",
    "registerCommands": true,
    "allowedUserIds": ${ALLOWED_IDS}
  },
  "proxy": "${PROXY_URL}"
}
CONF

if [ -n "$HF_TOKEN" ] && [ -n "$DATASET_ID" ]; then
  echo "Starting background data sync (dataset=${DATASET_ID})..."
  ./sync_data.sh > /tmp/sync.log 2>&1 &
  tail -f /tmp/sync.log &
fi

echo "Starting TavernPlusPlus headless + Telegram gateway..."
exec node src/combined-main.js
