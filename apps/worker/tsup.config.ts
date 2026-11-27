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

// Produção: pacotes do monorepo (@recpm/*) embutidos; dependências de npm vêm do node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  noExternal: [/^@recpm\//],
  esbuildPlugins: [externalNpm],
  sourcemap: true,
  clean: true,
});
