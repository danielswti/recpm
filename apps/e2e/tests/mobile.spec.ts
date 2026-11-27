/** Celular (375 px): login, painel e menu cabem na tela, sem rolagem horizontal. */
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, signUp } from "./helpers";

test("app usável em 375 px", async ({ page }) => {
  await page.goto("/entrar");
  await expectNoHorizontalScroll(page);
  await signUp(page, "Caio Rocha", "Agência Móvel");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await expect(page.getByRole("link", { name: "Tarefas" }).first()).toBeVisible();
  for (const path of ["/tarefas", "/projetos", "/configuracoes"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
  }
});

test("site usável em 375 px", async ({ page }) => {
  for (const path of ["/", "/precos", "/termos"]) {
    await page.goto(`http://localhost:5181${path}`);
    await expectNoHorizontalScroll(page);
  }
});
