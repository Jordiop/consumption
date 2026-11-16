#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_HOST:?Usa DEPLOY_HOST=usuario@servidor ./scripts/deploy.sh}"
DIR="${DEPLOY_DIR:-~/apps/consum}"
cd "$(dirname "$0")/.."

echo "→ Subiendo código a $DEPLOY_HOST:$DIR"
tar czf - Dockerfile docker-compose.yml .dockerignore requirements.txt app web \
  | ssh -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p $DIR && cd $DIR && rm -rf app web && tar xzf -"

echo "→ Reconstruyendo y arrancando"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd $DIR && docker compose up -d --build app && docker compose ps"
