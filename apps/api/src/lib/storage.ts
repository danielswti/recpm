/**
 * Armazenamento de arquivos (S3 compatível: R2 em produção, MinIO em dev). O binário vai direto do
 * navegador para o bucket por URL pré-assinada; a API só guarda metadados (tabela `files`).
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../env";

export type Storage = {
  /** URL para o navegador enviar o arquivo (PUT), válida por alguns minutos. */
  presignUpload(
    key: string,
    mimeType: string,
    sizeBytes: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** URL de download com o nome original. */
  presignDownload(key: string, fileName: string): Promise<string>;
  /** Tamanho do objeto no bucket, ou null se ainda não existe. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  /** Lê o objeto inteiro (usado para o hash e o PDF assinado; arquivos pequenos). */
  get(key: string): Promise<Uint8Array | null>;
  /** Grava um objeto gerado pela própria API (ex.: PDF assinado com certificado). */
  put(key: string, body: Uint8Array, mimeType: string): Promise<void>;
  /** Lê o objeto em partes (antivírus; não carrega o arquivo inteiro na memória). */
  stream(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Apaga o objeto (arquivo infectado). */
  remove(key: string): Promise<void>;
};

export const createStorage = (env: Env): Storage | null => {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  const bucket = env.S3_BUCKET;
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  return {
    async presignUpload(key, mimeType, sizeBytes) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes }),
        { expiresIn: 600 },
      );
      return { url, headers: { "Content-Type": mimeType } };
    },
    presignDownload(key, fileName) {
      const safe = encodeURIComponent(fileName);
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${safe}`,
        }),
        { expiresIn: 300 },
      );
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null;
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },
    async put(key, body, mimeType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mimeType }),
      );
    },
    async stream(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (r.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
      } catch (e) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: Number(r.ContentLength ?? 0) };
      } catch (e) {
        if (
          (e as { name?: string }).name === "NotFound" ||
          (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        )
          return null;
        throw e;
      }
    },
  };
};
