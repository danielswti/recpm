-- =============================================================================
-- Rec PM — papéis do Postgres (roda uma vez, como superusuário, na criação do cluster).
-- No docker-compose de dev é montado em /docker-entrypoint-initdb.d/.
-- Senhas vêm do ambiente (psql \getenv), nunca do repositório.
-- =============================================================================
\getenv owner_pw    RECPM_OWNER_PASSWORD
\getenv app_pw      RECPM_APP_PASSWORD
\getenv auth_pw     RECPM_AUTH_PASSWORD
\getenv platform_pw RECPM_PLATFORM_PASSWORD

-- Dono do schema. Usado SÓ por migrações (job único antes do deploy).
-- Como dono, ignora RLS — por isso a aplicação nunca conecta com ele.
CREATE ROLE recpm_owner LOGIN PASSWORD :'owner_pw';

-- API + worker. Sujeito a RLS (NOBYPASSRLS). Toda consulta roda dentro de withTenant().
CREATE ROLE recpm_app LOGIN NOBYPASSRLS PASSWORD :'app_pw';

-- Better Auth. Precisa enxergar memberships/convites de qualquer tenant (login, aceitar convite,
-- listar workspaces do usuário), então ignora RLS — mas só recebe GRANT nas tabelas de auth.
CREATE ROLE recpm_auth LOGIN BYPASSRLS PASSWORD :'auth_pw';

-- Back office do super_admin e webhooks de cobrança (Stripe/Asaas). Ignora RLS; usado só
-- nas rotas /platform/* (auditadas em platform_audit_logs) e no handler de webhooks.
CREATE ROLE recpm_platform LOGIN BYPASSRLS PASSWORD :'platform_pw';

ALTER DATABASE recpm OWNER TO recpm_owner;
REVOKE ALL ON DATABASE recpm FROM PUBLIC;
GRANT CONNECT ON DATABASE recpm TO recpm_app, recpm_auth, recpm_platform;

\connect recpm
ALTER SCHEMA public OWNER TO recpm_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recpm_app, recpm_auth, recpm_platform;
