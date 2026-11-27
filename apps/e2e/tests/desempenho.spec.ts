/** §9.10: JS da primeira tela < 250 KB (gzip) no build de produção. */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const DIST = new URL("../../web/dist", import.meta.url).pathname;

for (const path of ["/entrar", "/cadastro"]) {
  test(`JS inicial de ${path} abaixo de 250 KB gzip`, async ({ page }) => {
    const scripts = new Set<string>();
    page.on("request", (r) => {
      if (r.resourceType() === "script") scripts.add(new URL(r.url()).pathname);
    });
    await page.goto(path, { waitUntil: "networkidle" });
    let total = 0;
    for (const s of scripts) total += gzipSync(readFileSync(DIST + s), { level: 9 }).length;
    console.log(`${path}: ${scripts.size} arquivos, ${(total / 1024).toFixed(1)} KB gzip`);
    expect(total).toBeLessThan(250 * 1024);
  });
}
