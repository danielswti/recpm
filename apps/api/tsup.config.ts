import { defineConfig, type Options } from "tsup";

/** Pacotes de npm ficam externos (inclusive os que só os pacotes do monorepo usam). */
const externalNpm: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "external-npm",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (a) =>
      a.path.startsWith("@recpm/") ? undefined : { path: a.path, external: true },
    );
  },
};

// Produção: um único arquivo com os pacotes do monorepo (@recpm/*) embutidos; as dependências
// de npm ficam de fora e vêm do node_modules da imagem.
export default defineConfig({
  entry: { index: "src/index.ts", migrate: "../../packages/db/src/migrate.ts", seed: "scripts/seed.ts" },
  format: "esm",
  target: "node22",
  outDir: "dist",
  noExternal: [/^@recpm\//],
  esbuildPlugins: [externalNpm],
  sourcemap: true,
  clean: true,
});
