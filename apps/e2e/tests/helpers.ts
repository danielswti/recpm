import { expect, type Page } from "@playwright/test";

let seq = 0;
export const uniqEmail = (who: string) => `${who}-${Date.now().toString(36)}-${seq++}@e2e.test`;
export const PASSWORD = "senha-forte-123";

/** Cadastro pela tela: conta + workspace (trial), termina no painel. */
export async function signUp(page: Page, name = "Ana Souza", agency = "Agência E2E") {
  const email = uniqEmail(name.split(" ")[0]!.toLowerCase());
  await page.goto("/cadastro");
  await page.getByLabel("Seu nome").fill(name);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByLabel("Nome da agência").fill(agency);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText(`Olá, ${name.split(" ")[0]}`)).toBeVisible({ timeout: 15_000 });
  return { email };
}

/** Chamada à API com a sessão da página (para preparar dados sem repetir telas já testadas). */
export async function api<T = any>(
  page: Page,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
) {
  const base = new URL(page.url()).origin;
  const r = await page.request.fetch(`${base}/api/v1${path}`, {
    method,
    data,
    headers: { origin: base },
  });
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (r.status() === 204 ? null : await r.json()) as T;
}

/** Sem rolagem horizontal (layout cabe na largura da tela). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "a página não pode rolar na horizontal").toBeLessThanOrEqual(1);
}
