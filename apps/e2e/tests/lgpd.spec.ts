/** LGPD: o admin exclui o workspace (com confirmação) e perde o acesso a ele. */
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("excluir o workspace pelas configurações", async ({ page }) => {
  await signUp(page, "Bia Lima", "Agência Some");
  await page.goto("/configuracoes?tab=exports");
  await page.getByRole("button", { name: "Excluir workspace" }).click();
  const dlg = page.getByRole("dialog");
  const confirm = dlg.getByRole("button", { name: "Excluir workspace" });
  await expect(confirm).toBeDisabled();
  const slug = ((await dlg.getByText(/Digite .+ para confirmar/).textContent()) ?? "").match(
    /Digite (\S+) para/,
  )![1]!;
  await dlg.getByLabel("Endereço do workspace").fill(slug);
  await confirm.click();
  // sem workspace: volta para a escolha/criação de workspace
  await expect(page).not.toHaveURL(/configuracoes/, { timeout: 15_000 });
  const r = await page.request.get(`${new URL(page.url()).origin}/api/v1/workspace`);
  expect(r.status()).not.toBe(200);
});
