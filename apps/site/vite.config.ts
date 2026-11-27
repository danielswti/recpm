/**
 * Site de marketing (páginas estáticas). Cabeçalho e rodapé vêm de partials/ para não repetir
 * HTML em cada página. Em produção o Caddy serve este build no domínio principal e o app em app.<domínio>.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const partial = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "partials", `${name}.html`), "utf8");
const partials = (): Plugin => ({
  name: "recpm-partials",
  transformIndexHtml: (html) =>
    html.replace("<!--header-->", partial("header")).replace("<!--footer-->", partial("footer")),
});

const API = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [partials(), tailwindcss()],
  server: { proxy: { "/api": { target: API, changeOrigin: false } } },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        precos: resolve(import.meta.dirname, "precos.html"),
        privacidade: resolve(import.meta.dirname, "privacidade.html"),
        termos: resolve(import.meta.dirname, "termos.html"),
        404: resolve(import.meta.dirname, "404.html"),
      },
    },
  },
});
