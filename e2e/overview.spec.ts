// Story 10, end to end: an Admin opening Warden lands on the Overview, with Quick current after the seeded Scans and the
// trend over the demo seed; from there she reaches Findings, whose Level line links back to the journey.
import { ADA, expect, test } from "./session.ts";

test("Ada lands on Overview, sees Quick current and the trend, and goes to Findings and back by the Level line", async ({
  page,
  signIn,
}) => {
  await signIn(ADA);
  await page.goto("/");

  await expect(page).toHaveURL(/\/overview$/);
  const cards = page.getByRole("list", { name: "The journey" }).getByRole("listitem");
  await expect(cards.filter({ hasText: "Quick" })).toHaveAttribute("aria-current", "step");
  // The demo seed writes every Finding now: none was Open 30 days ago, 7 are now, and 1 of 11 was fixed.
  await expect(page.locator(".trend-line")).toHaveText(
    "Open Findings went from 0 to 7 in 30 days; fix rate 9%.",
  );

  await page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("link", { name: "Findings" })
    .click();
  await expect(page).toHaveURL(/\/findings$/);
  await expect(page.locator(".level-line")).toHaveText("Level: Quick · see the journey");

  await page.getByRole("link", { name: "see the journey" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator(".trend-line")).toHaveText(
    "Open Findings went from 0 to 7 in 30 days; fix rate 9%.",
  );
});
