#!/usr/bin/env bash
# Deploy de produção em um comando: ./infra/prod/deploy.sh
# Constrói as imagens da versão atual (git), migra o banco, sobe tudo e espera a API ficar saudável.
# Se a migração falhar, nada é trocado: a versão anterior continua no ar.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Falta infra/prod/.env (copie de .env.example)"; exit 1; }
set -a; . ./.env; set +a

RELEASE="${RELEASE:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
export RELEASE
echo "▶ Versão $RELEASE"

build() {
  # shellcheck disable=SC2086
  docker build ../.. ${BUILD_FLAGS:-} --target "$1" -t "recpm-$1:$RELEASE" -t "recpm-$1:latest" \
    --build-arg VITE_SENTRY_DSN="${VITE_SENTRY_DSN:-}" --build-arg VITE_RELEASE="$RELEASE"
}
echo "▶ Construindo imagens"
build api; build worker; build web

echo "▶ Subindo banco e Valkey"
docker compose up -d postgres valkey --wait

echo "▶ Backup antes da migração"
./backup.sh pre-deploy

echo "▶ Migrando"
docker compose --profile migrate run --rm migrate

if [ -n "${CLAMAV_HOST:-}" ]; then
  echo "▶ Antivírus"
  docker compose --profile antivirus up -d clamav
fi

echo "▶ Trocando API, worker e web"
docker compose up -d api worker web --wait --remove-orphans

echo "▶ Verificando"
for i in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    echo "✔ Rec PM $RELEASE no ar: https://app.$SITE_DOMAIN"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
echo "✘ A API não respondeu /health. Veja: docker compose logs api"; exit 1
