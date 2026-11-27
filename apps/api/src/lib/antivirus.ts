/**
 * Varredura de vírus com o ClamAV (clamd, comando INSTREAM por TCP). Liga com CLAMAV_HOST;
 * sem ele, `scan` responde "skipped" e o upload segue como antes (dev e testes).
 */
import { connect } from "node:net";

export type ScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "skipped"; reason: string };

export type Scanner = {
  /** Varre um fluxo de bytes. Lança erro se o clamd não responder. */
  scan(body: AsyncIterable<Uint8Array>): Promise<ScanResult>;
  maxBytes: number;
};

const CHUNK = 64 * 1024;

export function createClamdScanner(host: string, port = 3310, maxBytes = 512 * 1024 ** 2): Scanner {
  return {
    maxBytes,
    scan: (body) =>
      new Promise((resolve, reject) => {
        const sock = connect({ host, port });
        let reply = "";
        let done = false;
        const fail = (e: Error) => {
          if (done) return;
          done = true;
          sock.destroy();
          reject(e);
        };
        sock.setTimeout(120_000, () => fail(new Error("clamd: tempo esgotado")));
        sock.on("error", fail);
        sock.on("data", (d) => {
          reply += d.toString("utf8");
        });
        sock.on("end", () => {
          if (done) return;
          done = true;
          const r = reply.replace(/\0/g, "").trim(); // "stream: OK" | "stream: Eicar-Signature FOUND"
          if (r.endsWith("OK")) resolve({ status: "clean" });
          else if (r.endsWith("FOUND"))
            resolve({ status: "infected", signature: r.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, "") });
          else reject(new Error(`clamd: resposta inesperada (${r.slice(0, 120)})`));
        });
        sock.on("connect", async () => {
          try {
            sock.write("zINSTREAM\0");
            for await (const part of body) {
              for (let i = 0; i < part.length; i += CHUNK) {
                const piece = part.subarray(i, i + CHUNK);
                const len = Buffer.alloc(4);
                len.writeUInt32BE(piece.length);
                if (!sock.write(Buffer.concat([len, piece]))) await new Promise((r) => sock.once("drain", r));
              }
            }
            sock.end(Buffer.alloc(4)); // tamanho zero = fim do fluxo
          } catch (e) {
            fail(e as Error);
          }
        });
      }),
  };
}

export const noScanner: Scanner = {
  maxBytes: Number.POSITIVE_INFINITY,
  scan: async () => ({ status: "skipped", reason: "antivírus não configurado" }),
};
