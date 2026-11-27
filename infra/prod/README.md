# Produção (uma VPS)

Tudo roda em Docker Compose numa VPS Ubuntu (alvo: 4 vCPU, 8 GB). O Caddy é a única porta aberta
(80/443), emite os certificados HTTPS sozinho e serve:

| Endereço                           | O quê                                              |
| ---------------------------------- | -------------------------------------------------- |
| `https://SEU_DOMINIO`              | site de marketing e página de preços (`apps/site`) |
| `https://app.SEU_DOMINIO`          | o app (`apps/web`) e a API em `/api/*`             |
| `https://app.SEU_DOMINIO/api/docs` | documentação da API pública                        |

Postgres, Valkey, API e worker ficam só na rede interna do Docker. Os arquivos ficam no R2/S3.

## 1. Preparar a VPS (uma vez)

```bash
# DNS: registros A de SEU_DOMINIO, www.SEU_DOMINIO e app.SEU_DOMINIO apontando para a VPS
ssh root@VPS
git clone https://github.com/danielswti/recpm /opt/recpm
/opt/recpm/infra/prod/provision.sh     # Docker, firewall, fail2ban, swap, cron do backup
cd /opt/recpm/infra/prod
cp .env.example .env && chmod 600 .env && nano .env   # preencha domínio, senhas e chaves
```

## 2. Deploy (sempre o mesmo comando)

```bash
cd /opt/recpm && git pull && ./infra/prod/deploy.sh
```

Constrói as imagens da versão atual, faz um backup, migra o banco e só então troca API, worker e
web, esperando o `/health`. Se a migração falhar, a versão anterior continua no ar.

## 3. Backup e restauração

- **Automático:** todo dia às 03:15 (`/etc/cron.d/recpm-backup`), mantém `BACKUP_KEEP_DAYS` dias em
  `infra/prod/backups/` e envia uma cópia para fora da VPS se `BACKUP_S3_BUCKET` estiver no `.env`.
  Cada dump é conferido com `pg_restore --list` antes de valer.
- **Manual:** `./infra/prod/backup.sh antes-de-algo`
- **Restaurar (um comando):**

  ```bash
  ./infra/prod/restore.sh infra/prod/backups/recpm-AAAAMMDDTHHMMSSZ-daily.dump --yes
  ```

  Guarda o estado atual, para API e worker, recria o banco a partir do dump, reaplica migrações e
  RLS e sobe tudo. Para trazer um dump do R2: `aws s3 cp s3://BUCKET/postgres/ARQUIVO infra/prod/backups/`.

Teste a restauração de tempos em tempos numa VPS de teste: é o único jeito de saber que o backup serve.

## 4. Monitoramento

- **Erros:** preencha `SENTRY_DSN` (API e worker) e `VITE_SENTRY_DSN` (app) no `.env` e rode o deploy.
- **Disponibilidade:** `docker compose --profile monitoring up -d uptime` sobe o Uptime Kuma em
  `127.0.0.1:3001` (acesse com `ssh -L 3001:localhost:3001 root@VPS`). Monitore
  `https://app.SEU_DOMINIO/api/v1/health` e `https://SEU_DOMINIO`.
- **Logs:** `docker compose logs -f api worker` (JSON, com `requestId` em cada linha; rotação de 5×20 MB).
- **Consultas lentas:** o Postgres registra no log toda consulta acima de 500 ms.

## 5. Antivírus nos uploads (opcional, recomendado)

`docker compose --profile antivirus up -d clamav` e `CLAMAV_HOST=clamav` no `.env`. Sem ele, os
uploads são aceitos sem varredura (o limite de tamanho e o tipo continuam valendo).

## 6. Workspace de demonstração

```bash
docker compose run --rm api node dist/seed.js demo --email voce@seudominio.com.br
```

Cria a "Agência Demo" (plano Profissional, sem cobrança) com equipe, clientes, projetos, tarefas em
todas as colunas e um usuário do portal do cliente, e imprime os logins e a senha gerada.

## 7. Teste de carga (antes de abrir para clientes)

Numa VPS igual à de produção, **nunca no banco de produção** (o seed cria 50 workspaces):

```bash
mkdir -p /tmp/load && chmod 777 /tmp/load
docker compose run --rm -v /tmp/load:/out api node dist/seed.js load --sessions /out/sessoes.json
cp ../load/k6-listas.js /tmp/load/
docker run --rm --network host -v /tmp/load:/s -w /s -e BASE_URL=https://app.SEU_DOMINIO grafana/k6:1.4.2 run k6-listas.js
```

Critério: p95 abaixo de 200 ms nas quatro listas com 200 usuários simultâneos.

## Comandos úteis

```bash
cd /opt/recpm/infra/prod
docker compose ps                         # estado dos serviços
docker compose exec postgres psql -U postgres recpm
docker compose logs --since 1h api        # últimos erros
```
