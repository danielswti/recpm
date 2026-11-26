/** argon2id via binding nativo (@node-rs/argon2). Parâmetros = recomendação OWASP 2024 (m=19 MiB, t=2, p=1). */
import { hash, verify } from "@node-rs/argon2";

const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTS);
export const verifyPassword = ({ hash: h, password }: { hash: string; password: string }) =>
  verify(h, password).catch(() => false);
