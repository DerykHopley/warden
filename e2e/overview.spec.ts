// Story 10, end to end: an Admin opening Warden lands on the Overview, with Quick current after the seeded Scans and the
// trend over the demo seed; from there she reaches Findings, whose Level line links back to the journey. Then spec
// #341's stories 8 and 9 on Elm, a Team of their own: "Are we ready for the audit?" answered from VDA ISA 2027.1's
// Controls as an Admin reviews them through the API, and the journey's Audit-ready card with them; and the section's
// layout at three widths. The licence link's target and ring are setup.spec.ts's, and the credit's colour a unit
// test's: neither is read again here.
import type { Page } from "@playwright/test";
import { expectNoSidewaysScroll } from "./a11y.ts";
import { ADA, ELM, expect, ISA_PATH, MARY, sendAsAdmin, switchCatalogue, test } from "./session.ts";

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
  // Acme has no Catalogue on: the audit section keeps its line.
  await expect(
    page.getByText("Warden can answer this at Audit-ready, once Vouch checks your Controls."),
  ).toBeVisible();

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

const ISA_REFS = ["1.3.3", "1.3.4", "4.1.3", "5.2.4"];

/** Each of ISA2027's four Controls reviewed by Elm's Admin with `body`. */
async function reviewEach(body: object) {
  for (const ref of ISA_REFS) {
    await sendAsAdmin(ELM, "POST", `${ISA_PATH}/controls/${ref}/reviews`, body);
  }
}

const audit = (page: Page) => page.getByRole("region", { name: "Are we ready for the audit?" });
const rows = (page: Page) =>
  audit(page).getByRole("list", { name: "VDA ISA 2027.1 Controls" }).getByRole("listitem");
const card = (page: Page, word: string) =>
  page
    .getByRole("list", { name: "The journey" })
    .getByRole("listitem")
    .filter({ has: page.locator(".journey-level", { hasText: word }) });

test("Elm's Overview answers from ISA2027's Controls as Mary reviews them, and its journey reaches Audit-ready (#341 stories 8 and 9)", async ({
  page,
  signIn,
}) => {
  await switchCatalogue(ELM, true);
  await signIn(MARY, ELM);
  await page.goto("/overview");

  // Nothing reviewed: every Control waits, and Audit-ready isn't started.
  await expect(audit(page).locator(".audit-answer")).toHaveText(
    "Not yet: 4 Controls waiting for review.",
  );
  await expect(rows(page).locator(".audit-ref")).toHaveText(ISA_REFS);
  await expect(rows(page).locator(".audit-review")).toHaveText(Array(4).fill("Not reviewed"));
  await expect(card(page, "Audit-ready").locator(".journey-state")).toHaveText("Not started");
  await expect(card(page, "Audit-ready")).toContainText("0 of 4 Controls have a review");
  await expect(card(page, "Quick")).toHaveAttribute("aria-current", "step");

  // Each confirmed at not evidenced (Elm has no Scan): four Gaps, and the Team is Audit-ready.
  await reviewEach({ outcome: "confirm" });
  await page.reload();
  await expect(audit(page).locator(".audit-answer")).toHaveText("Not yet: 4 Gaps.");
  await expect(rows(page).locator(".audit-verdict")).toHaveText(Array(4).fill("Not evidenced"));
  await expect(rows(page).locator(".audit-gap")).toHaveText(Array(4).fill("Gap"));
  await expect(card(page, "Audit-ready")).toHaveAttribute("aria-current", "step");
  await expect(card(page, "Audit-ready").locator(".journey-state")).toHaveText("Current");
  await expect(card(page, "Audit-ready")).toContainText("4 of 4 Controls have a review");
  // The Level passed Quick on reviews alone; with no Scan, Quick's card isn't Done.
  await expect(card(page, "Quick").locator(".journey-state")).toHaveText("Not started");
  await expect(card(page, "Quick")).toContainText("Next: the first Scan");
  await expect(card(page, "Quick")).not.toHaveAttribute("aria-current");
  await expect(card(page, "Standard").locator(".journey-state")).toHaveText("Not started");
  await expect(card(page, "Standard")).toContainText("Warden doesn't check this yet.");

  // Each overridden to not applicable: no Gap, every Control reviewed.
  await reviewEach({
    outcome: "override",
    verdict: "not_applicable",
    reason: "Elm builds no product this Control covers.",
  });
  await page.reload();
  await expect(audit(page).locator(".audit-answer")).toHaveText(
    "Yes: all 4 Controls are reviewed, with no Gaps.",
  );
  await expect(rows(page).locator(".audit-verdict")).toHaveText(Array(4).fill("Not applicable"));
  await expect(rows(page).locator(".audit-review")).toHaveText(Array(4).fill("Reviewed"));
  await expect(rows(page).locator(".audit-gap")).toHaveCount(0);
  await expect(card(page, "Standard").locator(".journey-state")).not.toHaveText("Done");
});

for (const width of [390, 1024, 1600]) {
  test(`at ${width}px, Elm's audit section scrolls nothing sideways, its rows ${width < 640 ? "stacked" : "on one line"} (#341 story 8)`, async ({
    page,
    signIn,
  }) => {
    // On, whatever its reviews: the layout reads only the rows.
    await switchCatalogue(ELM, true);
    await page.setViewportSize({ width, height: 900 });
    await signIn(MARY, ELM);
    await page.goto("/overview");

    await expect(rows(page)).toHaveCount(4);
    await expect(audit(page).locator(".audit-answer")).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Under 640px the Verdict sits below the question; from 640px beside it, on the same line.
    for (const row of await rows(page).all()) {
      const question = (await row.locator(".audit-question").boundingBox())!;
      const verdict = (await row.locator(".audit-verdict").boundingBox())!;
      if (width < 640) {
        expect(verdict.y).toBeGreaterThanOrEqual(question.y + question.height - 1);
      } else {
        expect(verdict.x).toBeGreaterThanOrEqual(question.x + question.width);
        expect(verdict.y).toBeLessThan(question.y + question.height);
      }
    }
  });
}
