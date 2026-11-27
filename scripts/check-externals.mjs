// Confere se todo pacote npm importado pelo bundle (dist/*.js) existe no node_modules de produção.
// Uso: node scripts/check-externals.mjs <pasta-do-app>   (roda no build da imagem)
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const req = createRequire(join(root, "package.json"));
const builtins = new Set(builtinModules);
const missing = new Set();
for (const f of readdirSync(join(root, "dist")).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(root, "dist", f), "utf8");
  for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"'./][^"']*)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("node:") || builtins.has(spec)) continue;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    try {
      req.resolve(`${pkg}/package.json`);
    } catch {
      try {
        req.resolve(spec);
      } catch {
        missing.add(pkg);
      }
    }
  }
}
if (missing.size) {
  console.error(`Pacotes ausentes em ${root}: ${[...missing].join(", ")}`);
  process.exit(1);
}
console.log(`ok: dependências de ${root} completas`);
