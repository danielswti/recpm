/** Web push (VAPID) com a biblioteca web-push. Assinatura expirada (404/410) = apagar. */
import webpush from "web-push";
import type { Env } from "../env";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body?: string; url?: string; tag?: string };
export interface PushSender {
  publicKey: string;
  send(target: PushTarget, payload: PushPayload): Promise<{ gone: boolean }>;
}

export function createPushSender(env: Env): PushSender | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const details = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    async send(t, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          JSON.stringify(payload),
          { vapidDetails: details, TTL: 3600 },
        );
        return { gone: false };
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) return { gone: true };
        throw e;
      }
    },
  };
}
