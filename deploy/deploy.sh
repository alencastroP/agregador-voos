#!/usr/bin/env bash
# Roda NA VM a cada deploy (chamado pelo GitHub Actions via SSH).
# Entrada (env): IMAGE (ghcr.io/...:sha), VERSION (sha), GHCR_USER, GHCR_TOKEN (token efêmero do job).
set -euo pipefail

APP_DIR=/opt/agregador-voos
cd "$APP_DIR"
: "${IMAGE:?IMAGE obrigatória}" "${VERSION:?VERSION obrigatória}"
test -f .env || { echo "falta $APP_DIR/.env: rode deploy/bootstrap-vm.sh antes"; exit 1; }

# Fixa a versão no .env: um `docker compose up` depois de um reboot usa a MESMA imagem.
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
set_env AGGREGATOR_IMAGE "$IMAGE"
set_env APP_VERSION "$VERSION"

if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
fi

docker compose pull aggregator
# Mocks são construídos na própria VM (não estão em registry); o agregador vem do GHCR.
docker compose up -d --remove-orphans --wait --wait-timeout 240

docker logout ghcr.io >/dev/null 2>&1 || true
docker image prune -f --filter "until=168h" >/dev/null

docker compose ps --format 'table {{.Name}}\t{{.Status}}'
echo "deploy ok: $IMAGE"
