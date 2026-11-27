// Spec #341's Control card (slice 7a), end to end, on Fir: a Team of its own whose one Repo Asset was scanned an hour
// ago under both of 1.3.3's Rules, with one Open `guard/unapproved-ai-tool` Finding (the global setup's
// `seedFirControl`). Stories 2 and 3: a row on Overview opens 1.3.3's card with its Verdict, reason, credit and the
// Finding as a link to it on Findings; the card's layout at three widths; then stories 5 and 7: Fir's Admin confirms
// 1.3.3 through the API, the Member reads the review, and after the Admin marks the Finding a False positive the
// Verdict worked out now differs from the one reviewed.
//
// Serial, in one worker: the review and the False positive can't be undone, so they run last, after the tests that
// read 1.3.3 as the seed left it.
import { FindingsBody, type Finding } from "@warden/contracts";
import type { Locator, Page } from "@playwright/test";
import { expectNoSidewaysScroll, expectRings, expectTargets } from "./a11y.ts";
import {
  asAdmin,
  expect,
  FIR,
  FIR_REPO,
  FRANCES,
  ISA_PATH,
  JOAN,
  sendAsAdmin,
  switchCatalogue,
  test,
} from "./session.ts";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await switchCatalogue(FIR, true);
});

/** Fir's Open `guard/unapproved-ai-tool` Finding, read through the API as its Admin. */
async function firFinding(): Promise<Finding> {
  const { origin, headers } = await asAdmin(FIR);
  const res = await fetch(`${origin}/api/findings`, { headers });
  if (!res.ok) throw new Error(`listing Fir's Findings: ${res.status} ${await res.text()}`);
  const finding = FindingsBody.parse(await res.json()).findings.find(
    (f) => f.rule_id === "guard/unapproved-ai-tool",
  );
  if (finding === undefined) throw new Error("Fir has no unapproved-ai-tool Finding");
  return finding;
}

const QUESTION =
  /^To what extent is it ensured that only evaluated and approved external IT services/;

const rowButton = (page: Page, ref: string) =>
  page
    .getByRole("list", { name: "VDA ISA 2027.1 Controls" })
    .getByRole("listitem")
    .filter({ has: page.locator(".audit-ref", { hasText: ref }) })
    .getByRole("button");

const panel = (page: Page) => page.getByRole("complementary", { name: "Ask Warden" });
const card = (page: Page): Locator => panel(page).getByRole("region", { name: QUESTION });

/** Opens Overview at `width` and 1.3.3's card from its row, once its read has answered. */
async function openCard(page: Page, width = 1600) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/overview");
  await rowButton(page, "1.3.3").click();
  await expect(card(page).getByRole("region", { name: "Verdict" })).toBeVisible();
}

test("stories 2 and 3: 1.3.3's card shows its Verdict, reason, credit, and the Open Finding as a link to it on Findings", async ({
  page,
  signIn,
}) => {
  await signIn(FRANCES, FIR);
  await openCard(page);
  await expect(page).toHaveURL(/\/overview\?catalogue=vda-isa-2027\.1&control=1\.3\.3$/);
  await expect(rowButton(page, "1.3.3")).toHaveAttribute("aria-current", "true");

  const shown = card(page);
  await expect(shown.locator(".control-verdict")).toHaveText("Partly evidenced · Not reviewed");
  await expect(shown.locator(".control-reason")).toHaveText("1 Open Finding on 1 Repo");
  await expect(shown.getByText(/^© 2026 ENX Association/)).toBeVisible();
  const licence = shown.getByRole("link", { name: "CC BY-ND 4.0" });
  await expect(licence).toHaveAttribute("target", "_blank");
  await expect(licence).toHaveAttribute("rel", "noreferrer");
  await expect(panel(page).getByText(/^Talking about:/)).toHaveText(
    "Talking about: 1.3.3 · view: Overview",
  );

  // Both Rules covered by the Scan an hour ago, on the one Repo.
  const rules = shown.locator(".control-rules li");
  await expect(rules).toHaveCount(2);
  for (const rule of await rules.all()) await expect(rule).toContainText(", on 1 of 1 Repo");

  const { id, title } = await firFinding();
  const link = shown
    .getByRole("list", { name: "Open Findings" })
    .getByRole("link", { name: `${title} Medium · ${FIR_REPO.ref}` });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/findings\\?finding=${id}$`));
  await expect(panel(page).locator(".detail-card").getByRole("heading", { level: 3 })).toHaveText(
    title,
  );
});

for (const width of [390, 1024, 1600]) {
  test(`at ${width}px, the card scrolls nothing sideways and wraps its question; the row, the Finding link and the licence link are 44px targets with a focus ring`, async ({
    page,
    signIn,
  }) => {
    await signIn(FRANCES, FIR);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/overview");
    // The row before the panel opens over it, as a full screen on a phone.
    const row = rowButton(page, "1.3.3");
    await expect(row).toBeVisible();
    await expectTargets([row]);
    await expectRings(page, [row]);

    await row.click();
    const shown = card(page);
    await expect(shown.getByRole("region", { name: "Verdict" })).toBeVisible();
    await expectNoSidewaysScroll(page);
    const { scrollWidth, clientWidth } = await shown.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    // The question is longer than any card is wide: it takes more than one line.
    const title = shown.getByRole("heading", { level: 3 });
    const lines = await title.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(lines).toBeGreaterThan(1.5);

    const targets = [
      shown.getByRole("list", { name: "Open Findings" }).getByRole("link"),
      shown.getByRole("link", { name: "CC BY-ND 4.0" }),
    ];
    await expectTargets(targets);
    await expectRings(page, targets);
  });
}

test("stories 5 and 7: Joan reads Frances's confirmation, and after the Finding is a False positive, the card says the Verdict changed", async ({
  page,
  signIn,
}) => {
  await sendAsAdmin(FIR, "POST", `${ISA_PATH}/controls/1.3.3/reviews`, { outcome: "confirm" });
  await signIn(JOAN, FIR);
  await openCard(page);

  const shown = card(page);
  await expect(shown.locator(".control-verdict")).toHaveText("Partly evidenced · Reviewed");
  const reviews = shown.getByRole("list", { name: "Reviews" }).getByRole("listitem");
  await expect(reviews).toHaveCount(1);
  await expect(reviews.locator(".control-review-outcome")).toHaveText(
    "Confirmed: Partly evidenced",
  );
  await expect(reviews.locator(".control-review-by")).toContainText("By Frances Allen, ");
  // A Member sees the same card, with nothing in it to change the review.
  await expect(shown.getByRole("button")).toHaveText(["✕"]);

  const { id } = await firFinding();
  await sendAsAdmin(FIR, "POST", `/api/findings/${id}/false-positive`, {
    reason: "Fir approves Cursor for this repo.",
  });
  // The focus is in the address: a reload reopens the card, read again.
  await page.reload();
  await expect(shown.locator(".control-verdict")).toHaveText("Evidenced · Changed since review");
  await expect(shown.locator(".control-changed")).toHaveText(
    "The Verdict worked out now differs from the one last reviewed.",
  );
  await expect(shown.getByText("No Open Findings.")).toBeVisible();
  await expect(rowButton(page, "1.3.3").locator(".audit-review")).toHaveText(
    "Changed since review",
  );
});
