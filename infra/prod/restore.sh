#!/usr/bin/env bash
# Restauração em um comando: ./infra/prod/restore.sh backups/recpm-....dump --yes
# Para API e worker, recria o banco a partir do dump, reaplica migrações/RLS e sobe tudo de novo.
# APAGA os dados atuais do banco, por isso exige --yes. Antes, guarda um backup do estado atual.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
dump="${1:-}"; confirm="${2:-}"
[ -f "$dump" ] || { echo "Uso: $0 <arquivo.dump> --yes"; exit 1; }
[ "$confirm" = "--yes" ] || { echo "Isto substitui o banco atual. Rode de novo com --yes."; exit 1; }

docker compose up -d postgres --wait
docker compose exec -T postgres pg_restore --list < "$dump" > /dev/null || { echo "Dump inválido"; exit 1; }
./backup.sh pre-restore || echo "(sem backup do estado atual: banco vazio ou fora do ar)"

echo "▶ Parando API e worker"
docker compose stop api worker

echo "▶ Recriando o banco"
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'recpm' AND pid <> pg_backend_pid();
DROP DATABASE recpm;
CREATE DATABASE recpm OWNER recpm_owner;
REVOKE ALL ON DATABASE recpm FROM PUBLIC;
GRANT CONNECT ON DATABASE recpm TO recpm_app, recpm_auth, recpm_platform;
SQL
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -d recpm -c \
  "ALTER SCHEMA public OWNER TO recpm_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO recpm_app, recpm_auth, recpm_platform;"

echo "▶ Restaurando $dump"
docker compose exec -T postgres pg_restore -U postgres -d recpm --no-owner --role=recpm_owner --exit-on-error < "$dump"

echo "▶ Migrando (garante schema, RLS e permissões)"
docker compose --profile migrate run --rm migrate

echo "▶ Subindo API e worker"
docker compose up -d api worker --wait
docker compose exec -T api node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
echo "✔ Restaurado de $dump"
