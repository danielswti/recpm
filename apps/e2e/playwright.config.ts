/**
 * Testes E2E (§9.10): jornadas principais no navegador, contra o build de produção do app e do
 * site e a API real com um banco descartável. Precisa de TEST_PG_ADMIN_URL (como os testes da API).
 *   pnpm --filter @recpm/e2e e2e
 */
import { defineConfig, devices } from "@playwright/test";

const WEB = "http://localhost:5180";
const SITE = "http://localhost:5181";
const API_PORT = "3100";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: WEB, locale: "pt-BR", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile/ },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 740 }, hasTouch: true },
      testMatch: /mobile/,
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx start-api.ts",
      url: `http://localhost:${API_PORT}/health`,
      env: { E2E_API_PORT: API_PORT, E2E_WEB_URL: WEB },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "pnpm --filter @recpm/web exec vite build && pnpm --filter @recpm/web exec vite preview --port 5180 --strictPort",
      url: WEB,
      env: { VITE_API_PROXY: `http://localhost:${API_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command:
        "pnpm --filter @recpm/site exec vite build && pnpm --filter @recpm/site exec vite preview --port 5181 --strictPort",
      url: SITE,
      env: { VITE_API_PROXY: `http://localhost:${API_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
