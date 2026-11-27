-- =============================================================================
-- Rec PM — Row-Level Security, funções de contexto e GRANTs.
-- Aplicado como migração custom do drizzle-kit logo após o schema (roda como recpm_owner).
-- Idempotente: pode ser reaplicado depois de cada migração que cria tabelas.
--
-- MODELO
--   A API abre uma transação por request e define o contexto com set_config(..., true)
--   (equivalente a SET LOCAL, compatível com PgBouncer em transaction pooling):
--     app.tenant_id  → tenant ativo                (obrigatório; sem ele, nenhuma linha aparece)
--     app.user_id    → usuário autenticado          (políticas de dono e de chat)
--     app.client_id  → só para role = 'cliente'     (limita o portal ao próprio cliente)
--     app.actor      → 'user' | 'system'            ('system' = jobs do worker)
--
--   Camadas (todas precisam passar):
--     1. tenant_isolation (PERMISSIVE) ........ tenant_id = app.tenant_id()  — todas as tabelas do tenant
--     2. owner_only       (RESTRICTIVE) ....... notas, notificações, push: só o dono
--     3. participants     (RESTRICTIVE) ....... chat: só participantes
--     4. portal_*         (RESTRICTIVE) ....... sessão de cliente só vê o próprio cliente / itens visíveis
--
--   RLS é DEFESA EM PROFUNDIDADE: a API continua filtrando por tenant e checando RBAC.
--   O objetivo é que um WHERE esquecido nunca vaze dados entre tenants.
--
--   RLS fica ENABLE (não FORCE): o dono (recpm_owner) ignora, e é isso que permite as
--   funções SECURITY DEFINER abaixo. A aplicação nunca conecta como dono.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO recpm_app;

-- ── Contexto da sessão ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.client_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.client_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(current_setting('app.actor', true), '') = 'system' $$;

-- ── Funções SECURITY DEFINER (ignoram RLS de propósito, com escopo mínimo) ──
-- search_path fixo para não permitir sequestro de função.

-- O usuário `uid` é membro do tenant atual? (usada pela política de `users`)
CREATE OR REPLACE FUNCTION app.is_member_of_current_tenant(uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.tenant_id = app.tenant_id() AND m.user_id = uid
    )
  $$;

-- O usuário atual participa (ou criou) a conversa? Evita recursão entre as políticas do chat.
CREATE OR REPLACE FUNCTION app.can_access_conversation(conv uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM conversation_participants p
       WHERE p.tenant_id = app.tenant_id() AND p.conversation_id = conv AND p.user_id = app.user_id()
    ) OR EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.tenant_id = app.tenant_id() AND c.id = conv AND c.created_by = app.user_id()
    )
  $$;

-- Pontos de entrada SEM sessão: descobrem o tenant antes de abrir withTenant().
-- Retornam o mínimo necessário; a validação (hash, expiração) é feita na aplicação.
CREATE OR REPLACE FUNCTION app.resolve_api_key(p_prefix text)
  RETURNS TABLE (tenant_id uuid, api_key_id uuid, hashed_key text, created_by uuid,
                 expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT k.tenant_id, k.id, k.hashed_key, k.created_by, k.expires_at, k.revoked_at
      FROM api_keys k WHERE k.prefix = p_prefix
  $$;

CREATE OR REPLACE FUNCTION app.resolve_signer(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, signer_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT s.tenant_id, s.id, s.request_id FROM signers s WHERE s.token_hash = p_token_hash $$;

CREATE OR REPLACE FUNCTION app.resolve_signature_code(p_code text)
  RETURNS TABLE (tenant_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT r.tenant_id, r.id FROM signature_requests r WHERE r.verification_code = p_code $$;

-- Subdomínio/domínio próprio → tenant (branding da tela de login e do portal).
CREATE OR REPLACE FUNCTION app.resolve_tenant_host(p_slug_or_domain text)
  RETURNS TABLE (tenant_id uuid, slug text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.slug, t.name FROM tenants t
     WHERE t.deleted_at IS NULL
       AND (t.slug = lower(p_slug_or_domain) OR lower(t.custom_domain) = lower(p_slug_or_domain))
     LIMIT 1
  $$;

-- Fan-out dos jobs do worker: lista tenants ativos; cada job roda depois em withTenant().
CREATE OR REPLACE FUNCTION app.active_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT t.id FROM tenants t WHERE t.deleted_at IS NULL AND t.status <> 'suspended' $$;

-- Recorrências vencidas de TODOS os tenants (o job gera cada uma dentro do tenant certo).
CREATE OR REPLACE FUNCTION app.due_recurrences(p_now timestamptz, p_limit int DEFAULT 500)
  RETURNS TABLE (tenant_id uuid, task_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT t.tenant_id, t.id FROM tasks t
     WHERE t.recurrence IS NOT NULL AND t.next_generation_at <= p_now
       AND t.deleted_at IS NULL AND NOT t.archived
     ORDER BY t.next_generation_at
     LIMIT p_limit
  $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO recpm_app;

-- ── Classificação das tabelas ────────────────────────────────────────────────
-- Tabelas GLOBAIS (sem tenant_id):
--   auth ............ users, sessions, accounts, verifications, two_factors  → recpm_auth
--   plataforma ...... plans, coupons, billing_events, platform_audit_logs, public_holidays → recpm_platform
--   raiz ............ tenants (política própria: só o tenant atual)
-- Todas as demais têm tenant_id e recebem tenant_isolation automaticamente (bloco abaixo).

DO $$
DECLARE
  global_tables text[] := ARRAY[
    'users','sessions','accounts','verifications','two_factors',
    'plans','coupons','billing_events','platform_audit_logs','public_holidays','tenants'
  ];
  platform_only text[] := ARRAY['billing_events','platform_audit_logs'];
  t text;
BEGIN
  -- 1. Tenant isolation em toda tabela que tem tenant_id
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND c.table_name <> ALL (platform_only)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO recpm_app
         USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO recpm_app', t);
  END LOOP;

  -- Tabelas sem GRANT para a aplicação também ficam com RLS ligado (nega tudo por padrão).
  FOREACH t IN ARRAY global_tables || platform_only LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── Tabelas globais: o que a aplicação pode ver ──────────────────────────────
-- tenants: só o tenant atual. INSERT é liberado porque o cadastro do workspace roda dentro de
-- withTenant(<id novo>) — a política só aceita a linha cujo id é o do próprio contexto.
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants FOR ALL TO recpm_app
  USING (id = app.tenant_id()) WITH CHECK (id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenants TO recpm_app;

-- users: eu mesmo + membros do tenant atual (nomes/avatares de colegas). Escrita só via Better Auth.
DROP POLICY IF EXISTS users_visible ON users;
CREATE POLICY users_visible ON users FOR SELECT TO recpm_app
  USING (id = app.user_id() OR app.is_member_of_current_tenant(id));
GRANT SELECT ON users TO recpm_app;

-- plans e feriados: catálogo público, só leitura.
DROP POLICY IF EXISTS plans_read ON plans;
CREATE POLICY plans_read ON plans FOR SELECT TO recpm_app USING (true);
GRANT SELECT ON plans TO recpm_app;
DROP POLICY IF EXISTS public_holidays_read ON public_holidays;
CREATE POLICY public_holidays_read ON public_holidays FOR SELECT TO recpm_app USING (true);
GRANT SELECT ON public_holidays TO recpm_app;

-- Segredos: a aplicação lê/grava (para descriptografar ao chamar a IA), mas o portal nunca vê.
-- (A restrição do portal é aplicada no bloco "portal" abaixo.)

-- Auditoria imutável: só INSERT e SELECT.
REVOKE UPDATE, DELETE ON audit_logs FROM recpm_app;

-- Assinatura SaaS e contador de uso: a aplicação lê e incrementa; não cria/apaga assinatura.
REVOKE DELETE ON tenant_subscriptions, usage_counters FROM recpm_app;

-- ── 2. Só o dono ─────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['personal_notes','notification_preferences','push_subscriptions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS owner_only ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY owner_only ON public.%I AS RESTRICTIVE FOR ALL TO recpm_app
         USING (app.is_system() OR user_id = app.user_id())
         WITH CHECK (app.is_system() OR user_id = app.user_id())', t);
  END LOOP;
END $$;

-- Notificações: qualquer um do tenant pode CRIAR para outra pessoa (ex.: avisar o aprovador),
-- mas só o dono lê, marca como lida ou apaga.
DROP POLICY IF EXISTS owner_read ON notifications;
DROP POLICY IF EXISTS owner_update ON notifications;
DROP POLICY IF EXISTS owner_delete ON notifications;
CREATE POLICY owner_read ON notifications AS RESTRICTIVE FOR SELECT TO recpm_app
  USING (app.is_system() OR user_id = app.user_id());
CREATE POLICY owner_update ON notifications AS RESTRICTIVE FOR UPDATE TO recpm_app
  USING (app.is_system() OR user_id = app.user_id());
CREATE POLICY owner_delete ON notifications AS RESTRICTIVE FOR DELETE TO recpm_app
  USING (app.is_system() OR user_id = app.user_id());

-- ── 3. Chat: só participantes ────────────────────────────────────────────────
DROP POLICY IF EXISTS participants ON conversations;
CREATE POLICY participants ON conversations AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.is_system() OR created_by = app.user_id() OR app.can_access_conversation(id))
  WITH CHECK (app.is_system() OR created_by = app.user_id() OR app.can_access_conversation(id));

DROP POLICY IF EXISTS participants ON conversation_participants;
CREATE POLICY participants ON conversation_participants AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.is_system() OR app.can_access_conversation(conversation_id))
  WITH CHECK (app.is_system() OR app.can_access_conversation(conversation_id));

DROP POLICY IF EXISTS participants ON messages;
CREATE POLICY participants ON messages AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.is_system() OR app.can_access_conversation(conversation_id))
  WITH CHECK (app.is_system() OR app.can_access_conversation(conversation_id));

-- Anexos herdam a visibilidade da mensagem (a subconsulta já passa pelo RLS de messages).
DROP POLICY IF EXISTS participants ON message_attachments;
CREATE POLICY participants ON message_attachments AS RESTRICTIVE FOR ALL TO recpm_app
  USING (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id))
  WITH CHECK (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id));

-- ── 4. Portal do cliente (app.client_id() preenchido) ────────────────────────
-- Regra geral: em sessão de cliente, TUDO é negado, exceto as tabelas liberadas abaixo.
-- Novas tabelas nascem negadas para o portal (o bloco abaixo roda de novo a cada migração).
DO $$
DECLARE
  -- leitura e escrita com condição própria (políticas logo abaixo)
  portal_scoped text[] := ARRAY[
    'clients','projects','project_phases','project_milestones','project_comments',
    'project_folders','project_attachments','tasks','task_subitems','task_feedback',
    'task_attachments','task_deliveries','signature_requests','signers',
    'briefing_responses','demand_requests','memberships','files'
  ];
  -- só leitura (catálogos para montar o portal)
  portal_read_only text[] := ARRAY[
    'briefing_forms','briefing_fields','kanban_columns','task_types','project_types','tenant_settings'
  ];
  -- dono já restringe; o portal pode usar normalmente
  portal_owner_scoped text[] := ARRAY[
    'notifications','notification_preferences','push_subscriptions','personal_notes'
  ];
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND c.table_name NOT IN ('billing_events','platform_audit_logs')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS portal_deny ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS portal_deny_write ON public.%I', t);
    IF t = ANY (portal_scoped) OR t = ANY (portal_owner_scoped) THEN
      CONTINUE;
    ELSIF t = ANY (portal_read_only) THEN
      EXECUTE format(
        'CREATE POLICY portal_deny_write ON public.%I AS RESTRICTIVE FOR INSERT TO recpm_app
           WITH CHECK (app.client_id() IS NULL)', t);
      EXECUTE format('DROP POLICY IF EXISTS portal_deny_update ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY portal_deny_update ON public.%I AS RESTRICTIVE FOR UPDATE TO recpm_app
           USING (app.client_id() IS NULL)', t);
      EXECUTE format('DROP POLICY IF EXISTS portal_deny_delete ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY portal_deny_delete ON public.%I AS RESTRICTIVE FOR DELETE TO recpm_app
           USING (app.client_id() IS NULL)', t);
    ELSIF t = 'audit_logs' THEN
      -- ações do cliente são auditadas (INSERT), mas ele não lê a auditoria
      EXECUTE format(
        'CREATE POLICY portal_deny ON public.%I AS RESTRICTIVE FOR SELECT TO recpm_app
           USING (app.client_id() IS NULL)', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY portal_deny ON public.%I AS RESTRICTIVE FOR ALL TO recpm_app
           USING (app.client_id() IS NULL) WITH CHECK (app.client_id() IS NULL)', t);
    END IF;
  END LOOP;
END $$;

-- Helper de leitura: macro "não é portal OU <condição>"
-- (escrito por extenso em cada política para o planner conseguir usar índices)

DROP POLICY IF EXISTS portal_scope ON clients;
CREATE POLICY portal_scope ON clients AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR id = app.client_id())
  WITH CHECK (app.client_id() IS NULL OR id = app.client_id());

DROP POLICY IF EXISTS portal_scope ON projects;
CREATE POLICY portal_scope ON projects AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (client_id = app.client_id() AND deleted_at IS NULL))
  WITH CHECK (app.client_id() IS NULL OR client_id = app.client_id());

-- Filhos de projeto: visíveis se o projeto for visível (a subconsulta passa pelo RLS de projects).
DROP POLICY IF EXISTS portal_scope ON project_phases;
CREATE POLICY portal_scope ON project_phases AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON project_milestones;
CREATE POLICY portal_scope ON project_milestones AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON project_folders;
CREATE POLICY portal_scope ON project_folders AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON project_attachments;
CREATE POLICY portal_scope ON project_attachments AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL);

-- Comentários: o cliente lê os visíveis e pode responder (a resposta nasce visível e é dele).
DROP POLICY IF EXISTS portal_scope ON project_comments;
CREATE POLICY portal_scope ON project_comments AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL OR (visible_to_client AND author_id = app.user_id()
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)));

-- Tarefas: só as marcadas como visíveis, de projetos do cliente. O cliente pode criar,
-- atualizar (ex.: aprovar entrega) e apagar tarefas, sempre dentro dos próprios projetos e
-- sempre visíveis para ele. Tarefa criada pelo portal conta na cota do plano (source = 'portal').
DROP POLICY IF EXISTS portal_scope ON tasks;
CREATE POLICY portal_scope ON tasks AS RESTRICTIVE FOR SELECT TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)));
DROP POLICY IF EXISTS portal_update ON tasks;
CREATE POLICY portal_update ON tasks AS RESTRICTIVE FOR UPDATE TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL OR (visible_to_client
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)));
DROP POLICY IF EXISTS portal_insert ON tasks;
CREATE POLICY portal_insert ON tasks AS RESTRICTIVE FOR INSERT TO recpm_app
  WITH CHECK (app.client_id() IS NULL OR (visible_to_client
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)));
DROP POLICY IF EXISTS portal_delete ON tasks;
CREATE POLICY portal_delete ON tasks AS RESTRICTIVE FOR DELETE TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)));

-- Filhos de tarefa (a subconsulta passa pelo RLS de tasks).
DROP POLICY IF EXISTS portal_scope ON task_subitems;
CREATE POLICY portal_scope ON task_subitems AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON task_deliveries;
CREATE POLICY portal_scope ON task_deliveries AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON task_attachments;
CREATE POLICY portal_scope ON task_attachments AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id)))
  WITH CHECK (app.client_id() IS NULL OR (visible_to_client AND created_by = app.user_id()
              AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id)));

DROP POLICY IF EXISTS portal_scope ON task_feedback;
CREATE POLICY portal_scope ON task_feedback AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (visible_to_client AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id)))
  WITH CHECK (app.client_id() IS NULL OR (visible_to_client AND author_id = app.user_id()
              AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id)));

-- Assinaturas: documentos dos projetos do cliente; o cliente não cria pedidos.
DROP POLICY IF EXISTS portal_scope ON signature_requests;
CREATE POLICY portal_scope ON signature_requests AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR (status <> 'rascunho' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id)))
  WITH CHECK (app.client_id() IS NULL);

DROP POLICY IF EXISTS portal_scope ON signers;
CREATE POLICY portal_scope ON signers AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id))
  WITH CHECK (app.client_id() IS NULL OR user_id = app.user_id());

-- Briefings e demandas: sempre do próprio cliente.
DROP POLICY IF EXISTS portal_scope ON briefing_responses;
CREATE POLICY portal_scope ON briefing_responses AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR client_id = app.client_id())
  WITH CHECK (app.client_id() IS NULL OR client_id = app.client_id());

DROP POLICY IF EXISTS portal_scope ON demand_requests;
CREATE POLICY portal_scope ON demand_requests AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR client_id = app.client_id())
  WITH CHECK (app.client_id() IS NULL OR (client_id = app.client_id() AND status = 'pending'));

-- Memberships: o cliente só vê o próprio vínculo (custo/hora e dados de RH ficam invisíveis).
DROP POLICY IF EXISTS portal_scope ON memberships;
CREATE POLICY portal_scope ON memberships AS RESTRICTIVE FOR ALL TO recpm_app
  USING (app.client_id() IS NULL OR user_id = app.user_id())
  WITH CHECK (app.client_id() IS NULL
              OR (user_id = app.user_id() AND role = 'cliente' AND client_id = app.client_id()));

-- Arquivos: os que o cliente enviou + os anexados a itens que ele já pode ver.
DROP POLICY IF EXISTS portal_scope ON files;
CREATE POLICY portal_scope ON files AS RESTRICTIVE FOR ALL TO recpm_app
  USING (
    app.client_id() IS NULL
    OR uploaded_by = app.user_id()
    OR EXISTS (SELECT 1 FROM project_attachments a WHERE a.file_id = files.id)
    OR EXISTS (SELECT 1 FROM task_attachments a WHERE a.file_id = files.id)
    OR EXISTS (SELECT 1 FROM signature_requests r
                WHERE r.document_file_id = files.id OR r.signed_file_id = files.id)
  )
  WITH CHECK (app.client_id() IS NULL OR uploaded_by = app.user_id());

-- ── Vínculo do portal herda o cliente do convite ─────────────────────────────
-- O Better Auth cria o vínculo no aceite sem campos extras; este gatilho copia o client_id do
-- convite aceito mais recente (mesmo tenant, mesmo e-mail, papel cliente).
CREATE OR REPLACE FUNCTION app.membership_client_from_invitation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NEW.role = 'cliente' AND NEW.client_id IS NULL THEN
      SELECT i.client_id INTO NEW.client_id
        FROM invitations i
        JOIN users u ON lower(u.email) = lower(i.email)
       WHERE u.id = NEW.user_id
         AND i.tenant_id = NEW.tenant_id
         AND i.role = 'cliente'
         AND i.status IN ('accepted', 'pending')
       ORDER BY i.updated_at DESC
       LIMIT 1;
    END IF;
    RETURN NEW;
  END $$;
DROP TRIGGER IF EXISTS memberships_client_from_invitation ON memberships;
CREATE TRIGGER memberships_client_from_invitation BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.membership_client_from_invitation();

-- ── "Trabalhando agora" em tempo real ───────────────────────────────────────
-- Toda mudança em time_entries avisa a API (LISTEN recpm_time) depois do COMMIT. O payload é só
-- o tenant_id: a API reconsulta com RLS, então nada vaza entre tenants.
CREATE OR REPLACE FUNCTION app.notify_time_entries() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
  BEGIN
    PERFORM pg_notify('recpm_time', COALESCE(NEW.tenant_id, OLD.tenant_id)::text);
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS time_entries_notify ON time_entries;
CREATE TRIGGER time_entries_notify AFTER INSERT OR UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION app.notify_time_entries();

-- Notificações novas (payload "tenant:usuário") e mudanças no chat ("tenant:conversa").
CREATE OR REPLACE FUNCTION app.notify_notifications() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
  BEGIN
    PERFORM pg_notify('recpm_notify', NEW.tenant_id::text || ':' || NEW.user_id::text);
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS notifications_notify ON notifications;
CREATE TRIGGER notifications_notify AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION app.notify_notifications();

CREATE OR REPLACE FUNCTION app.notify_chat() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
  DECLARE r record := COALESCE(NEW, OLD);
  BEGIN
    PERFORM pg_notify('recpm_chat', r.tenant_id::text || ':' || r.conversation_id::text);
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS messages_notify ON messages;
CREATE TRIGGER messages_notify AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION app.notify_chat();
DROP TRIGGER IF EXISTS conversation_participants_notify ON conversation_participants;
CREATE TRIGGER conversation_participants_notify AFTER INSERT OR UPDATE OR DELETE ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION app.notify_chat();

-- ── Webhooks de saída (§6.13) ────────────────────────────────────────────────
-- Os eventos nascem aqui, na mesma transação da mudança, venha ela da tela, da API, do portal ou
-- dos jobs (recorrência). SECURITY DEFINER porque o portal não enxerga webhook_endpoints.
-- Só enfileira quando há endpoint ativo para o evento e o plano inclui webhooks; a API entrega
-- (LISTEN recpm_webhooks) com assinatura HMAC e novas tentativas.
CREATE OR REPLACE FUNCTION app.enqueue_webhook(p_tenant uuid, p_event text, p_data jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
  DECLARE n int;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM webhook_endpoints e
                    WHERE e.tenant_id = p_tenant AND e.active AND p_event = ANY (e.events)) THEN
      RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenant_subscriptions s JOIN plans p ON p.id = s.plan_id
                    WHERE s.tenant_id = p_tenant AND (p.features->>'outgoingWebhooks')::boolean) THEN
      RETURN;
    END IF;
    INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event, payload, status, next_attempt_at)
    SELECT gen_random_uuid(), p_tenant, e.id, p_event, p_data, 'pending', now()
      FROM webhook_endpoints e
     WHERE e.tenant_id = p_tenant AND e.active AND p_event = ANY (e.events);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN PERFORM pg_notify('recpm_webhooks', p_tenant::text); END IF;
  END $$;

CREATE OR REPLACE FUNCTION app.task_webhook_data(t tasks) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
  AS $$
    SELECT jsonb_build_object(
      'id', t.id, 'title', t.title, 'projectId', t.project_id, 'statusKey', t.status_key,
      'assigneeId', t.assignee_id, 'taskTypeId', t.task_type_id, 'priority', t.priority,
      'deadline', t.deadline, 'pieceQuantity', t.piece_quantity, 'source', t.source,
      'visibleToClient', t.visible_to_client, 'completedAt', t.completed_at, 'createdAt', t.created_at)
  $$;

CREATE OR REPLACE FUNCTION app.tasks_webhooks() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM app.enqueue_webhook(NEW.tenant_id, 'task.created', jsonb_build_object('task', app.task_webhook_data(NEW)));
    ELSIF NEW.status_key IS DISTINCT FROM OLD.status_key THEN
      PERFORM app.enqueue_webhook(NEW.tenant_id, 'task.status_changed',
        jsonb_build_object('task', app.task_webhook_data(NEW), 'from', OLD.status_key, 'to', NEW.status_key));
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
      PERFORM app.enqueue_webhook(NEW.tenant_id, 'task.completed', jsonb_build_object('task', app.task_webhook_data(NEW)));
    END IF;
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS tasks_webhooks ON tasks;
CREATE TRIGGER tasks_webhooks AFTER INSERT OR UPDATE OF status_key, completed_at ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.tasks_webhooks();

CREATE OR REPLACE FUNCTION app.projects_webhooks() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
  BEGIN
    PERFORM app.enqueue_webhook(NEW.tenant_id, 'project.created', jsonb_build_object('project', jsonb_build_object(
      'id', NEW.id, 'name', NEW.name, 'clientId', NEW.client_id, 'modality', NEW.modality,
      'status', NEW.status, 'managerId', NEW.manager_id, 'startDate', NEW.start_date, 'createdAt', NEW.created_at)));
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS projects_webhooks ON projects;
CREATE TRIGGER projects_webhooks AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION app.projects_webhooks();

CREATE OR REPLACE FUNCTION app.installments_webhooks() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NEW.status = 'pago' AND OLD.status IS DISTINCT FROM 'pago' THEN
      PERFORM app.enqueue_webhook(NEW.tenant_id, 'installment.paid', jsonb_build_object('installment', jsonb_build_object(
        'id', NEW.id, 'number', NEW.number, 'contractId', NEW.contract_id,
        'clientSubscriptionId', NEW.client_subscription_id, 'clientId', NEW.client_id,
        'amountCents', NEW.amount_cents, 'dueDate', NEW.due_date, 'paidAt', NEW.paid_at,
        'paidAmountCents', NEW.paid_amount_cents, 'method', NEW.method)));
    END IF;
    RETURN NULL;
  END $$;
DROP TRIGGER IF EXISTS installments_webhooks ON installments;
CREATE TRIGGER installments_webhooks AFTER UPDATE OF status ON installments
  FOR EACH ROW EXECUTE FUNCTION app.installments_webhooks();
REVOKE ALL ON FUNCTION app.enqueue_webhook(uuid, text, jsonb) FROM PUBLIC, recpm_app;

-- ── Verificação de cobertura (rodada no CI e no teste de isolamento) ─────────
-- Falha se existir tabela com tenant_id sem RLS ou sem a política tenant_isolation.
CREATE OR REPLACE FUNCTION app.assert_rls_coverage() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public
  AS $$
  DECLARE missing text;
  BEGIN
    SELECT string_agg(c.relname, ', ') INTO missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname NOT IN ('billing_events','platform_audit_logs')
       AND (NOT c.relrowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'));
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'Tabelas sem RLS de tenant: %', missing;
    END IF;
  END $$;

-- ── GRANTs para Better Auth e plataforma ─────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
   ON users, sessions, accounts, verifications, two_factors, tenants, memberships, invitations
   TO recpm_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recpm_platform;
GRANT USAGE ON SCHEMA app TO recpm_platform;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO recpm_platform;
