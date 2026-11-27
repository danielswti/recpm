/** Jornada principal: cadastro → projeto → tarefa → lista e quadro → sair e entrar de novo. */
import { expect, test } from "@playwright/test";
import { api, PASSWORD, signUp } from "./helpers";

test("cadastro, projeto, tarefa e novo login", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { email } = await signUp(page);
  await api(page, "POST", "/clients", { code: "CAFE", name: "Café Aroma" });

  await page.goto("/projetos");
  await page.getByRole("button", { name: "Novo projeto" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Nome", { exact: true }).fill("Café Aroma | Lançamento");
  await dlg
    .getByLabel("Cliente", { exact: true })
    .selectOption({ label: "CAFE · Café Aroma" })
    .catch(async () => {
      await dlg.getByLabel("Cliente", { exact: true }).selectOption({ index: 1 });
    });
  await dlg.getByRole("button", { name: "Criar projeto" }).click();
  await expect(page.getByRole("heading", { name: "Café Aroma | Lançamento" })).toBeVisible();

  await page.getByRole("button", { name: "Nova tarefa" }).click();
  const t = page.getByRole("dialog");
  await t.getByLabel("Título").fill("Post de lançamento");
  await t.getByRole("button", { name: "Criar tarefa" }).click();
  await expect(page.getByText("Post de lançamento").first()).toBeVisible();

  await page.goto("/tarefas");
  await expect(page.getByText("Post de lançamento").first()).toBeVisible();

  await page.getByRole("button", { name: "Menu do usuário" }).click();
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await page.waitForURL(/entrar/);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("senha-errada-1");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Olá, Ana")).toBeVisible();
  expect(errors).toEqual([]);
});
