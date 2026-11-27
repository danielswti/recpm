import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            // Diálogos e menus (Radix + posicionamento) num pedaço à parte: login e cadastro não
            // usam e ficam abaixo de 250 KB de JS inicial (§9.10).
            {
              name: "overlays",
              test: /node_modules[\\/](@radix-ui[\\/]react-(dialog|dropdown-menu|menu|popper|portal|presence|focus-scope|focus-guards|dismissable-layer|roving-focus|collection|direction|arrow|use-size|use-rect)|@floating-ui|react-remove-scroll|react-style-singleton|aria-hidden|use-callback-ref|use-sidecar|get-nonce|detect-node-es)|packages[\\/]ui[\\/]src[\\/]components[\\/](dialog|dropdown-menu)/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    // Mesmo domínio em dev e em produção (Caddy): cookies de sessão SameSite=Lax sem CORS.
    proxy: { "/api": { target: API, changeOrigin: false } },
  },
});
