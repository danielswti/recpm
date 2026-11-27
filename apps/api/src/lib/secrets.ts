/**
 * Criptografia dos segredos do tenant (tenant_secrets): AES-256-GCM, formato `v1:iv:tag:dados`
 * (base64). A chave vem de SECRETS_KEY (32 bytes em base64). Sem ela, fora de produção, deriva
 * uma chave do BETTER_AUTH_SECRET para o dev funcionar; em produção SECRETS_KEY é obrigatória.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Env } from "../env";
import { AppError } from "./errors";

export function secretsKey(env: Env): Buffer {
  if (env.SECRETS_KEY) {
    const k = Buffer.from(env.SECRETS_KEY, "base64");
    if (k.length !== 32) throw new Error("SECRETS_KEY precisa ter 32 bytes em base64");
    return k;
  }
  if (env.NODE_ENV === "production")
    throw new AppError(503, "SECRETS_KEY_MISSING", "Criptografia de segredos não configurada.");
  return createHash("sha256").update(`recpm-secrets:${env.BETTER_AUTH_SECRET}`).digest();
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(enc: string, key: Buffer): string {
  const [v, iv, tag, data] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("segredo em formato desconhecido");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
