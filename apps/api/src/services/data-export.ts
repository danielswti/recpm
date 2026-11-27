/**
 * Exportação de dados do tenant (§6.14): um .zip com um arquivo por tabela (JSON ou CSV) e um
 * manifest.json. Roda no processo da API (que tem o armazenamento): "Exportar agora" acorda pelo
 * NOTIFY recpm_exports e, a cada 5 min, a agenda de cada workspace cria as exportações vencidas.
 *
 * Segredos nunca saem: colunas *_enc, hashed_key, token_hash e tabelas de segredo ficam de fora.
 * Pedidos concorrentes: cada exportação é reivindicada com FOR UPDATE SKIP LOCKED.
 */
import { createHash } from "node:crypto";
import { schema } from "@recpm/db";
import { eq, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { uuidv7 } from "uuidv7";
import type { Deps } from "../deps";
import { createStorage, type Storage } from "../lib/storage";

const s = schema;
const SKIP_TABLES = new Set(["tenant_secrets", "billing_events", "platform_audit_logs"]);
const SECRET_COL = /(_enc|^hashed_key|^token_hash|^password)$/;
const PAGE = 5000;

type Pending = { id: string; tenant_id: string; format: string };

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const t = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Próxima execução agendada: (última agendada + N dias, ou hoje) no horário local "HH:mm". */
export function scheduleDue(
  sched: { everyNDays: number; at: string },
  lastScheduledAt: Date | null,
  now: Date,
  tz: string,
) {
  const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(d);
  const localHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const today = local(now);
  if (localHm < sched.at) return false;
  if (!lastScheduledAt) return true;
  const last = new Date(`${local(lastScheduledAt)}T00:00:00Z`);
  const days = Math.round((new Date(`${today}T00:00:00Z`).getTime() - last.getTime()) / 86_400_000);
  return days >= sched.everyNDays;
}

export function createDataExporter(deps: Deps, opts: { storage?: Storage | null } = {}) {
  const db = deps.dbs.platformDb;
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : deps.storage !== undefined
        ? deps.storage
        : createStorage(deps.env);
  const doFetch = deps.fetch ?? fetch;

  async function tenantTables(): Promise<string[]> {
    const r = await db.execute<{ table_name: string }>(sql`
      SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name`);
    return r.rows.map((x) => x.table_name).filter((t) => !SKIP_TABLES.has(t));
  }

  async function build(tenantId: string, format: "json" | "csv") {
    const files: Record<string, Uint8Array> = {};
    const counts: Record<string, number> = {};
    const tables = await tenantTables();
    for (const t of tables) {
      const rows: Record<string, unknown>[] = [];
      let offset = 0;
      for (;;) {
        const page = await db.execute<Record<string, unknown>>(
          sql`SELECT * FROM ${sql.identifier(t)} WHERE tenant_id = ${tenantId} ORDER BY 1 LIMIT ${PAGE} OFFSET ${offset}`,
        );
        rows.push(...page.rows);
        if (page.rows.length < PAGE) break;
        offset += PAGE;
      }
      for (const r of rows) for (const k of Object.keys(r)) if (SECRET_COL.test(k)) delete r[k];
      counts[t] = rows.length;
      if (!rows.length) continue;
      if (format === "json") files[`${t}.json`] = strToU8(JSON.stringify(rows, null, 1));
      else {
        const cols = Object.keys(rows[0]!);
        files[`${t}.csv`] = strToU8(
          `﻿${[cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n")}`,
        );
      }
    }
    // Pessoas do workspace (users não tem tenant_id): só id, nome e e-mail de quem é membro.
    const people = await db.execute<Record<string, unknown>>(sql`
      SELECT u.id, u.name, u.email, m.role, m.active FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ${tenantId} ORDER BY u.name`);
    counts.users = people.rows.length;
    if (format === "json") files["users.json"] = strToU8(JSON.stringify(people.rows, null, 1));
    else
      files["users.csv"] = strToU8(
        `﻿id,name,email,role,active\r\n${people.rows.map((r) => ["id", "name", "email", "role", "active"].map((c) => csvCell(r[c])).join(",")).join("\r\n")}`,
      );
    const [tenant] = await db
      .select({ name: s.tenants.name, slug: s.tenants.slug })
      .from(s.tenants)
      .where(eq(s.tenants.id, tenantId));
    files["manifest.json"] = strToU8(
      JSON.stringify(
        {
          app: "Rec PM",
          version: 1,
          tenant: { id: tenantId, ...tenant },
          format,
          exportedAt: new Date().toISOString(),
          counts,
        },
        null,
        1,
      ),
    );
    return { zip: zipSync(files, { level: 6 }), slug: tenant?.slug ?? "workspace" };
  }

  async function runOne(e: Pending) {
    try {
      if (!storage) throw new Error("Armazenamento de arquivos não configurado.");
      const format = e.format === "csv" ? "csv" : "json";
      const { zip, slug } = await build(e.tenant_id, format);
      const now = new Date();
      const fileId = uuidv7();
      const key = `t/${e.tenant_id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${fileId}`;
      const name = `recpm-${slug}-${now.toISOString().slice(0, 10)}-${format}.zip`;
      await storage.put(key, zip, "application/zip");
      await db.insert(s.files).values({
        id: fileId,
        tenantId: e.tenant_id,
        storageKey: key,
        originalName: name,
        mimeType: "application/zip",
        sizeBytes: zip.byteLength,
        sha256: createHash("sha256").update(zip).digest("hex"),
        scanStatus: "clean",
      });
      await db
        .update(s.dataExports)
        .set({ status: "succeeded", fileId, finishedAt: new Date(), error: null })
        .where(eq(s.dataExports.id, e.id));
      await notifyDestination(e, key, name, zip.byteLength);
      return true;
    } catch (err) {
      deps.logger.warn({ err, export: e.id }, "falha na exportação de dados");
      await db
        .update(s.dataExports)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        })
        .where(eq(s.dataExports.id, e.id));
      return false;
    }
  }

  /** Entrega opcional: avisa a URL configurada com um link de download temporário. */
  async function notifyDestination(e: Pending, key: string, name: string, size: number) {
    const [st] = await db
      .select({ b: s.tenantSettings.backupSchedule })
      .from(s.tenantSettings)
      .where(eq(s.tenantSettings.tenantId, e.tenant_id));
    const url = st?.b.destination?.kind === "webhook" ? st.b.destination.url : undefined;
    if (!url || !storage) return;
    try {
      await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "RecPM-Exports/1.0" },
        body: JSON.stringify({
          event: "export.ready",
          exportId: e.id,
          tenantId: e.tenant_id,
          fileName: name,
          sizeBytes: size,
          downloadUrl: await storage.presignDownload(key, name),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      deps.logger.warn({ err, export: e.id }, "falha ao avisar o destino da exportação");
    }
  }

  /** Cria as exportações agendadas que venceram (uma por workspace por vez). */
  async function schedule(now = new Date()) {
    const rows = await db.execute<{
      tenant_id: string;
      b: { enabled: boolean; everyNDays: number; at: string; format: string };
      tz: string;
      last: Date | null;
      busy: boolean;
    }>(sql`
      SELECT st.tenant_id, st.backup_schedule AS b, t.timezone AS tz,
             (SELECT max(e.created_at) FROM data_exports e WHERE e.tenant_id = st.tenant_id AND e.trigger = 'schedule') AS last,
             EXISTS (SELECT 1 FROM data_exports e WHERE e.tenant_id = st.tenant_id AND e.status IN ('pending','running')) AS busy
        FROM tenant_settings st JOIN tenants t ON t.id = st.tenant_id
       WHERE (st.backup_schedule->>'enabled')::boolean AND t.deleted_at IS NULL AND t.status <> 'suspended'`);
    let created = 0;
    for (const r of rows.rows) {
      if (r.busy || !scheduleDue(r.b, r.last ? new Date(r.last) : null, now, r.tz)) continue;
      await db.insert(s.dataExports).values({
        tenantId: r.tenant_id,
        trigger: "schedule",
        format: r.b.format === "csv" ? "csv" : "json",
      });
      created++;
    }
    return created;
  }

  async function runOnce(): Promise<number> {
    // exportação presa (processo caiu no meio): volta para a fila depois de 30 min
    await db.execute(sql`
      UPDATE data_exports SET status = 'pending', started_at = NULL
       WHERE status = 'running' AND started_at < now() - interval '30 minutes'`);
    let done = 0;
    for (;;) {
      const claimed = await db.execute<Pending>(sql`
        UPDATE data_exports SET status = 'running', started_at = now()
         WHERE id = (SELECT id FROM data_exports WHERE status = 'pending'
                      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, format`);
      const e = claimed.rows[0];
      if (!e) return done;
      await runOne(e);
      done++;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  const kick = (withSchedule = false) => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        if (withSchedule) await schedule();
        do {
          again = false;
          await runOnce();
        } while (again);
      } catch (err) {
        deps.logger.error({ err }, "exportador de dados falhou");
      } finally {
        running = false;
      }
    })();
  };

  return {
    runOnce,
    schedule,
    build,
    start() {
      const off = deps.live?.subscribe("recpm_exports", "*", () => kick());
      timer = setInterval(() => kick(true), 5 * 60_000);
      kick(true);
      return () => {
        off?.();
        if (timer) clearInterval(timer);
      };
    },
  };
}
