#!/usr/bin/env bash
# Backup do banco: ./infra/prod/backup.sh [rótulo]
# pg_dump em formato custom, conferido com pg_restore --list, guardado em infra/prod/backups/
# (mantém BACKUP_KEEP_DAYS dias) e, se BACKUP_S3_BUCKET estiver definido, copiado para fora da VPS.
# O cron instalado pelo provision.sh roda isto todo dia às 03:15.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
label="${1:-daily}"
mkdir -p backups
file="backups/recpm-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"

docker compose exec -T postgres pg_dump -U postgres -d recpm -Fc -Z 6 > "$file.tmp"
# Confere se o arquivo é um dump legível antes de considerar o backup válido
docker compose exec -T postgres pg_restore --list < "$file.tmp" > /dev/null
mv "$file.tmp" "$file"
echo "✔ Backup $file ($(du -h "$file" | cut -f1))"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  docker run --rm -v "$PWD/backups:/b:ro" \
    -e AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto amazon/aws-cli:2.22.0 \
    s3 cp "/b/$(basename "$file")" "s3://$BACKUP_S3_BUCKET/postgres/$(basename "$file")" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} --only-show-errors
  echo "✔ Copiado para s3://$BACKUP_S3_BUCKET/postgres/"
fi

find backups -name 'recpm-*.dump' -mtime "+${BACKUP_KEEP_DAYS:-14}" -delete
