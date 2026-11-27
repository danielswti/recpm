/**
 * Despachante de notificações: e-mail e web push conforme as preferências de cada pessoa.
 * Roda no processo da API (que tem o mailer); várias instâncias não duplicam envios porque cada
 * lote é reivindicado com FOR UPDATE SKIP LOCKED. Acorda pelo NOTIFY e, por garantia, a cada 30 s.
 */
import { schema } from "@recpm/db";
import { NOTIFICATION_TYPES, type NotificationType, notificationPath } from "@recpm/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import type { PushSender } from "../lib/push";

const s = schema;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Row = {
  id: string;
  tenant_id: string;
  user_id: string;
  type: string;
  title: string;
  message: string | null;
  reference_type: string | null;
  reference_id: string | null;
};

export function createNotificationDispatcher(deps: Deps, push: PushSender | null) {
  const db = deps.dbs.platformDb;

  async function runOnce(limit = 100): Promise<{ sent: number; email: number; push: number }> {
    const claimed = await db.execute<Row>(sql`
      UPDATE notifications SET dispatched_at = now()
       WHERE id IN (
         SELECT id FROM notifications WHERE dispatched_at IS NULL
          ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, user_id, type, title, message, reference_type, reference_id`);
    const rows = claimed.rows;
    if (!rows.length) return { sent: 0, email: 0, push: 0 };

    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const prefs = await db
      .select()
      .from(s.notificationPreferences)
      .where(inArray(s.notificationPreferences.userId, userIds));
    const users = await db
      .select({ id: s.users.id, email: s.users.email, name: s.users.name })
      .from(s.users)
      .where(inArray(s.users.id, userIds));
    const subs = push
      ? await db.select().from(s.pushSubscriptions).where(inArray(s.pushSubscriptions.userId, userIds))
      : [];
    const tenants = await db
      .select({ id: s.tenants.id, name: s.tenants.name })
      .from(s.tenants)
      .where(inArray(s.tenants.id, [...new Set(rows.map((r) => r.tenant_id))]));

    let email = 0;
    let pushed = 0;
    for (const n of rows) {
      const def = NOTIFICATION_TYPES[n.type as NotificationType] ?? { email: false, push: true };
      const p = prefs.find((x) => x.tenantId === n.tenant_id && x.userId === n.user_id && x.type === n.type);
      const wantEmail = p ? p.email : def.email;
      const wantPush = p ? p.push : def.push;
      const url = `${deps.env.WEB_URL}${notificationPath(n.reference_type, n.reference_id)}`;
      const ws = tenants.find((t) => t.id === n.tenant_id)?.name ?? "Rec PM";
      try {
        if (wantEmail) {
          const u = users.find((x) => x.id === n.user_id);
          if (u?.email) {
            await deps.mailer.send({
              to: u.email,
              subject: `${n.title} · ${ws}`,
              text: `${n.title}\n${n.message ?? ""}\n\nAbrir: ${url}\n\nVocê pode mudar os avisos por e-mail em Conta > Notificações.`,
              html: `<p><strong>${esc(n.title)}</strong></p>${n.message ? `<p>${esc(n.message)}</p>` : ""}<p><a href="${esc(url)}">Abrir no Rec PM</a></p><p style="color:#64748b;font-size:12px">${esc(ws)} · Você pode mudar os avisos por e-mail em Conta &gt; Notificações.</p>`,
            });
            email++;
          }
        }
        if (wantPush && push) {
          for (const sub of subs.filter((x) => x.tenantId === n.tenant_id && x.userId === n.user_id)) {
            const r = await push.send(sub, {
              title: n.title,
              body: n.message ?? ws,
              url,
              tag: n.reference_id ?? n.id,
            });
            if (r.gone) await db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.id, sub.id));
            else {
              pushed++;
              await db
                .update(s.pushSubscriptions)
                .set({ lastUsedAt: new Date() })
                .where(and(eq(s.pushSubscriptions.id, sub.id)));
            }
          }
        }
      } catch (err) {
        deps.logger.warn({ err, notification: n.id }, "falha ao despachar notificação");
      }
    }
    return { sent: rows.length, email, push: pushed };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let again = false;
  const kick = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          while ((await runOnce()).sent === 100);
        } while (again);
      } catch (err) {
        deps.logger.error({ err }, "despachante de notificações falhou");
      } finally {
        running = false;
      }
    })();
  };

  return {
    runOnce,
    start() {
      const off = deps.live?.subscribe("recpm_notify", "*", kick);
      timer = setInterval(kick, 30_000);
      kick();
      return () => {
        off?.();
        if (timer) clearInterval(timer);
      };
    },
  };
}
