// Gera .gz (nível 9) e .br (qualidade 11) ao lado dos arquivos estáticos, para o Caddy servir
// já comprimido (file_server precompressed): menos bytes que a compressão na hora e zero CPU.
// Uso: node scripts/precompress.mjs apps/web/dist apps/site/dist
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TYPES = /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml|map)$/;
let files = 0;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TYPES.test(name) && statSync(p).size > 1024) {
      const buf = readFileSync(p);
      const gz = gzipSync(buf, { level: 9 });
      const br = brotliCompressSync(buf, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
      });
      writeFileSync(`${p}.gz`, gz);
      writeFileSync(`${p}.br`, br);
      files++;
      before += buf.length;
      after += gz.length;
    }
  }
};
for (const dir of process.argv.slice(2)) walk(dir);
console.log(
  `precompress: ${files} arquivos, ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (gzip -9)`,
);
