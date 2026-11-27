// Spec #341's Control card (slice 7a), end to end, on Fir: a Team of its own whose one Repo Asset was scanned an hour
// ago under both of 1.3.3's Rules, with one Open `guard/unapproved-ai-tool` Finding (the global setup's
// `seedFirControl`). Stories 2 and 3: a row on Overview opens 1.3.3's card with its Verdict, reason, credit and the
// Finding as a link to it on Findings; the card's layout at three widths; then stories 5 and 7: Fir's Admin confirms
// 1.3.3 through the API, the Member reads the review, and after the Admin marks the Finding a False positive the
// Verdict worked out now differs from the one reviewed.
//
// Slice 7b: Fir's Admin confirms 4.1.3 and overrides 5.2.4 in their cards (story 4), a double click on Confirm's submit
// for 1.3.4 stores one review, the open forms' layout at three widths, and the Member sees only the line saying a Lead
// or an Admin reviews a Control (story 5).
//
// Serial, in one worker: the reviews and the False positive can't be undone, so they run after the tests that read
// the seed's Controls as it left them, each review on its own Control.
import { ControlDetail, FindingsBody, type Finding } from "@warden/contracts";
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
/** The one Control card the panel shows, whichever Control it is. */
const anyCard = (page: Page): Locator => panel(page).locator(".control-card");

/** Opens Overview at `width` and `ref`'s card from its row, once its read has answered. */
async function openCard(page: Page, width = 1600, ref = "1.3.3") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/overview");
  await rowButton(page, ref).click();
  await expect(anyCard(page).getByRole("region", { name: "Verdict" })).toBeVisible();
}

/** `ref`'s reviews in Fir, read through the API as its Admin. */
async function firReviews(ref: string) {
  const { origin, headers } = await asAdmin(FIR);
  const res = await fetch(`${origin}${ISA_PATH}/controls/${ref}`, { headers });
  if (!res.ok) throw new Error(`reading Fir's ${ref}: ${res.status} ${await res.text()}`);
  return ControlDetail.parse(await res.json()).reviews;
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

  // A line for each of 1.3.3's Rules; their words are ruleEvidenceWords', unit-tested in the dashboard.
  await expect(shown.locator(".control-rules li code")).toHaveText([
    "guard/unapproved-ai-tool",
    "guard/mcp-server-unpinned",
  ]);

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

for (const width of [390, 1024, 1600]) {
  test(`at ${width}px, the open Confirm and Override forms scroll nothing sideways; their buttons, radios, submits and Cancel are 44px targets with a focus ring`, async ({
    page,
    signIn,
  }) => {
    await signIn(FRANCES, FIR);
    await openCard(page, width);
    const shown = card(page);
    const actions = shown.getByRole("group", { name: "Review" });
    const openers = [
      actions.getByRole("button", { name: "Confirm" }),
      actions.getByRole("button", { name: "Override" }),
    ];
    await expectTargets(openers);
    await expectRings(page, openers);

    await openers[0]!.click();
    const confirm = shown.getByRole("form", { name: "Confirm the Verdict" });
    await expect(confirm).toBeVisible();
    await expectNoSidewaysScroll(page);
    const confirmButtons = [
      confirm.getByRole("button", { name: "Confirm" }),
      confirm.getByRole("button", { name: "Cancel" }),
    ];
    await expectTargets(confirmButtons);
    await expectRings(page, confirmButtons);
    await confirm.getByRole("button", { name: "Cancel" }).click();

    await actions.getByRole("button", { name: "Override" }).click();
    const override = shown.getByRole("form", { name: "Override the Verdict" });
    await expect(override).toBeVisible();
    await expectNoSidewaysScroll(page);
    // A radio's target is its whole row: the label it sits in.
    await expectTargets(await override.locator("label.candidate").all());
    // Each radio picked first, so the keyboard's Tab into the group lands on it, not on the group's first.
    for (const radio of await override.getByRole("radio").all()) {
      await radio.check();
      await expectRings(page, [radio]);
    }
    await override.getByRole("textbox", { name: "Reason" }).fill("Measured at this width");
    const overrideButtons = [
      override.getByRole("button", { name: "Override" }),
      override.getByRole("button", { name: "Cancel" }),
    ];
    await expectTargets(overrideButtons);
    await expectRings(page, overrideButtons);
  });
}

test("story 4: Frances confirms 4.1.3 in its card; its Reviews gain hers, and its row reads Reviewed and Gap without a reload", async ({
  page,
  signIn,
}) => {
  await signIn(FRANCES, FIR);
  await openCard(page, 1600, "4.1.3");
  const shown = anyCard(page);
  await shown
    .getByRole("group", { name: "Review" })
    .getByRole("button", { name: "Confirm" })
    .click();
  await shown
    .getByRole("form", { name: "Confirm the Verdict" })
    .getByRole("button", { name: "Confirm" })
    .click();

  await expect(shown.getByRole("status")).toHaveText("Confirmed.");
  await expect(shown.getByRole("status")).toBeFocused();
  const reviews = shown.getByRole("list", { name: "Reviews" }).getByRole("listitem");
  await expect(reviews).toHaveCount(1);
  await expect(reviews.locator(".control-review-outcome")).toHaveText("Confirmed: Not evidenced");
  await expect(reviews.locator(".control-review-by")).toContainText("By you");
  const row = rowButton(page, "4.1.3");
  await expect(row.locator(".audit-review")).toHaveText("Reviewed");
  await expect(row.locator(".audit-gap")).toHaveText("Gap");
});

test("story 4: Frances overrides 5.2.4 to Not applicable with a reason, and its row reads Not applicable and Reviewed", async ({
  page,
  signIn,
}) => {
  await signIn(FRANCES, FIR);
  await openCard(page, 1600, "5.2.4");
  const shown = anyCard(page);
  await shown
    .getByRole("group", { name: "Review" })
    .getByRole("button", { name: "Override" })
    .click();
  const form = shown.getByRole("form", { name: "Override the Verdict" });
  const submit = form.getByRole("button", { name: "Override" });
  await form.getByRole("radio", { name: "Not applicable" }).check();
  await expect(submit).toBeDisabled();
  await form.getByRole("textbox", { name: "Reason" }).fill("Fir builds no software for customers.");
  await submit.click();

  await expect(shown.getByRole("status")).toHaveText("Overridden to Not applicable.");
  const reviews = shown.getByRole("list", { name: "Reviews" }).getByRole("listitem");
  await expect(reviews.locator(".control-review-reason")).toHaveText(
    "Fir builds no software for customers.",
  );
  const row = rowButton(page, "5.2.4");
  await expect(row.locator(".audit-verdict")).toHaveText("Not applicable");
  await expect(row.locator(".audit-review")).toHaveText("Reviewed");
});

test("one review per submit: a double click on Confirm's submit for 1.3.4 stores one review", async ({
  page,
  signIn,
}) => {
  const before = (await firReviews("1.3.4")).length;
  await signIn(FRANCES, FIR);
  await openCard(page, 1600, "1.3.4");
  const shown = anyCard(page);
  await shown
    .getByRole("group", { name: "Review" })
    .getByRole("button", { name: "Confirm" })
    .click();
  await shown
    .getByRole("form", { name: "Confirm the Verdict" })
    .getByRole("button", { name: "Confirm" })
    .dblclick();

  await expect(shown.getByRole("status")).toHaveText("Confirmed.");
  await expect(shown.getByRole("list", { name: "Reviews" }).getByRole("listitem")).toHaveCount(
    before + 1,
  );
  expect(await firReviews("1.3.4")).toHaveLength(before + 1);
});

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
  // Story 5: a Member sees the same card, with nothing in it to change the review, only the line saying who can.
  await expect(shown.getByRole("button")).toHaveText(["✕"]);
  await expect(shown.getByRole("form")).toHaveCount(0);
  await expect(shown.getByText("A Lead or an Admin reviews this Control.")).toBeVisible();

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
