/** Web push: registra o service worker e inscreve o navegador com a chave VAPID do servidor. */
import { api, unwrap, unwrapVoid } from "./api";

export const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

const b64ToBytes = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Pede permissão e inscreve; devolve false se a pessoa negou ou o servidor não tem VAPID. */
export async function enablePush(): Promise<"ok" | "denied" | "unavailable"> {
  if (!pushSupported()) return "unavailable";
  const { key } = await unwrap(api.push["public-key"].$get());
  if (!key) return "unavailable";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await unwrapVoid(api.push.subscriptions.$post({ json: { endpoint: json.endpoint, keys: json.keys } }));
  return "ok";
}

export async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await unwrapVoid(api.push.unsubscribe.$post({ json: { endpoint: sub.endpoint } }));
  await sub.unsubscribe();
}
