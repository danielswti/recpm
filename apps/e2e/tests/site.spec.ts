/** Site de marketing: planos vindos da API, comparação, aviso de cookies e links para o app. */
import { expect, test } from "@playwright/test";

const SITE = "http://localhost:5181";

test("home, preços e aviso de cookies", async ({ page }) => {
  await page.goto(SITE);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("[data-plans] > *")).toHaveCount(4);
  await expect(page.getByText("R$ 247").first()).toBeVisible();

  const banner = page.locator("[data-cookie-banner]");
  await expect(banner).toBeVisible();
  await banner.locator("[data-cookie-ok]").click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(banner).toBeHidden();

  await page.goto(`${SITE}/precos`);
  await expect(page.locator("[data-compare] tbody tr").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Testar grátis/ }).first()).toHaveAttribute(
    "href",
    /\/cadastro/,
  );
  await page.goto(`${SITE}/privacidade`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Privacidade/i);
});
