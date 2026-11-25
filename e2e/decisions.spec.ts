// Story 4 in the detail card (docs/design.md: Detail card, Chat message, Accessibility floor): a Lead's decisions and a
// Member's Proposal end to end, the chat keeping its newest message in view, and the card's controls by keyboard, at
// phone size and without sideways scroll. Every test reads Bluebird, which no other browser test reads, and puts back
// what it changed (each Finding's seeded Status, no Proposal left pending) even when it fails. The words, the bodies
// sent, who sees which button and each refusal are dashboard/test/DetailCard.test.tsx's.
import type { Locator, Page } from "@playwright/test";
import { expectRings, expectTargets } from "./a11y.ts";
import {
  BLUEBIRD,
  expect,
  LINUS,
  MARGARET,
  sessionToken,
  signingKey,
  test,
  type Person,
} from "./session.ts";

const panel = (page: Page) => page.getByRole("complementary", { name: "Ask Warden" });
const card = (page: Page) => panel(page).locator(".detail-card");

/** A Member's line in place of the Propose buttons while the Finding has a pending Proposal. */
const WAITING = "Waiting for a Lead or Admin to decide.";

/** A far Reopens on day, so every run's accept is in the future whatever the day. */
const UNTIL = "2099-01-15";

type FindingRow = { id: string; title: string; status: string };

/** Calls Warden's API as `person` in Bluebird, as the dashboard would. */
async function apiAs(baseURL: string | undefined, person: Person) {
  const origin = new URL(baseURL!).origin;
  const role = person === BLUEBIRD.admin ? "admin" : "member";
  const token = await sessionToken(await signingKey(), origin, person, BLUEBIRD, role);
  const call = (path: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const findings = async () =>
    ((await (await call("/api/findings")).json()) as { findings: FindingRow[] }).findings;
  return {
    call,
    async finding(titleStart: string, status = "open"): Promise<FindingRow> {
      const found = (await findings()).find(
        (f) => f.title.startsWith(titleStart) && f.status === status,
      );
      if (found === undefined) throw new Error(`no ${status} Finding "${titleStart}…" in Bluebird`);
      return found;
    },
    /** Puts the Open Finding `id` back as seeded (a Lead's calls): Open, and no Proposal of it left pending. */
    async restore(id: string) {
      const { proposals } = (await (await call("/api/proposals")).json()) as {
        proposals: { id: string; finding_id: string }[];
      };
      for (const proposal of proposals.filter((p) => p.finding_id === id)) {
        await call(`/api/proposals/${proposal.id}/reject`, { reason: "Put back after a test" });
      }
      if ((await findings()).find((f) => f.id === id)?.status !== "open") {
        await call(`/api/findings/${id}/reopen`, { reason: "Put back after a test" });
      }
    },
  };
}

/** Margaret asks for `id` to be marked a False positive, through the API. */
async function proposeAsMargaret(baseURL: string | undefined, id: string, reason: string) {
  const asked = await (
    await apiAs(baseURL, MARGARET)
  ).call(`/api/findings/${id}/proposals`, { decision: "mark_false_positive", reason });
  expect(asked.status).toBe(201);
}

/** The table row of the Finding `id`, by its short id: two demo Findings share a title. */
const rowById = (page: Page, id: string) =>
  page.locator(".findings-table tbody tr").filter({
    has: page.locator(".rule-id", { hasText: id.slice(0, 8) }),
  });

/** Opens Findings with every Status in the table, and focuses `finding` from its row. */
async function focus(page: Page, finding: FindingRow, width = 1600, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto("/findings?status=all");
  await rowById(page, finding.id).getByRole("button").click();
  await expect(card(page).getByRole("heading", { level: 3 })).toHaveText(finding.title);
}

test("story 4: Linus accepts and reopens a Finding; Margaret proposes a False positive on another, and Linus approves it", async ({
  page,
  signIn,
  baseURL,
}) => {
  const linus = await apiAs(baseURL, LINUS);
  const lodash = await linus.finding("lodash 4.17.20");
  const disk = await linus.finding("The disk isn't encrypted");
  const reason = "The laptop is a kiosk with nothing on it";
  try {
    await signIn(MARGARET, BLUEBIRD);
    await focus(page, disk);
    await card(page).getByRole("button", { name: "Propose False positive" }).click();
    const propose = card(page).getByRole("form", { name: "Propose False positive" });
    await propose.getByRole("textbox", { name: "Reason" }).fill(reason);
    await propose.getByRole("button", { name: "Propose" }).click();
    await expect(card(page).getByRole("status")).toHaveText(
      "Proposal sent. A Lead or an Admin decides.",
    );
    // One pending Proposal per Finding: hers waits, so no Propose buttons. The sent line says so, alone: one box.
    await expect(card(page).getByRole("button", { name: /^Propose/ })).toHaveCount(0);
    await expect(card(page).locator(".card-line")).toHaveCount(1);
    // Opened again, the waiting line stands in the Propose buttons' place.
    await focus(page, disk);
    await expect(card(page).getByText(WAITING)).toBeVisible();
    await expect(card(page).getByRole("button", { name: /^Propose/ })).toHaveCount(0);

    await signIn(LINUS, BLUEBIRD);
    await focus(page, lodash);
    const statusCell = rowById(page, lodash.id).locator("td").last();
    await card(page).getByRole("button", { name: "Accept" }).click();
    const accept = card(page).getByRole("form", { name: "Accept" });
    await accept
      .getByRole("textbox", { name: "Why accept this risk?" })
      .fill("Only a dev dependency");
    await accept.getByLabel("Reopens on").fill(UNTIL);
    await accept.getByRole("button", { name: "Accept" }).click();
    // The day as the browser says it, in its own locale: "Jan 15, 2099" in English.
    const untilDay = await page.evaluate(
      (day) => new Date(`${day}T12:00`).toLocaleDateString(undefined, { dateStyle: "medium" }),
      UNTIL,
    );
    await expect(card(page).getByRole("status")).toHaveText(`Accepted. Reopens on ${untilDay}.`);
    await expect(card(page).locator("time", { hasText: untilDay })).toBeVisible();
    await expect(card(page).locator(".detail-status")).toContainText("Accepted");
    await expect(statusCell).toHaveText("Accepted");

    await card(page).getByRole("button", { name: "Reopen" }).click();
    const reopen = card(page).getByRole("form", { name: "Reopen" });
    await reopen.getByRole("textbox", { name: "Reason" }).fill("The dev server ships it after all");
    await reopen.getByRole("button", { name: "Reopen" }).click();
    await expect(card(page).getByRole("status")).toHaveText("Reopened.");
    await expect(card(page).locator(".detail-status")).toContainText("Open");
    await expect(statusCell).toHaveText("Open");

    const { history } = (await (await linus.call(`/api/findings/${lodash.id}/history`)).json()) as {
      history: { status_after: string; cause: unknown; reason: string }[];
    };
    expect(history.slice(-2)).toEqual([
      expect.objectContaining({
        status_after: "accepted",
        cause: { kind: "person", id: LINUS.userId },
        reason: "Only a dev dependency",
      }),
      expect.objectContaining({
        status_after: "open",
        cause: { kind: "person", id: LINUS.userId },
        reason: "The dev server ships it after all",
      }),
    ]);

    await rowById(page, disk.id).getByRole("button").click();
    const hers = card(page).getByRole("listitem").filter({ hasText: reason });
    await expect(hers).toContainText("Asked by Margaret Hamilton");
    await hers.getByRole("button", { name: "Approve" }).click();
    await expect(card(page).getByRole("status")).toHaveText("Proposal approved.");
    await expect(hers).toHaveCount(0);
    await expect(card(page).locator(".detail-status")).toContainText("False positive");

    // Nothing waits on the Finding now: reopened, Margaret's card has her Propose buttons again and no line.
    // (A False positive card shows neither, so it is reopened first to make the check mean something.)
    await linus.restore(disk.id);
    await signIn(MARGARET, BLUEBIRD);
    await focus(page, disk);
    await expect(card(page).getByRole("button", { name: "Propose False positive" })).toBeVisible();
    await expect(card(page).getByText(WAITING)).toHaveCount(0);
  } finally {
    await linus.restore(lodash.id);
    await linus.restore(disk.id);
  }
});

test("with a detail card showing at 1600 by 600px, each send keeps Warden's newest reply in view", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn(LINUS, BLUEBIRD);
  const target = await (await apiAs(baseURL, LINUS)).finding("lodash 4.17.20");
  await focus(page, target, 1600, 600);
  const body = panel(page).locator(".panel-body");

  for (let sent = 1; sent <= 3; sent++) {
    await panel(page).getByRole("textbox", { name: "Message" }).fill(`What now? (${sent})`);
    await panel(page).getByRole("button", { name: "Send" }).click();
    const replies = panel(page).locator('.chat-message[data-from="warden"]');
    await expect(replies).toHaveCount(sent);
    // The card and the chat outgrow the panel, so the body scrolls: the test means something.
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const reply = (await replies.last().boundingBox())!;
    const box = (await body.boundingBox())!;
    expect(reply.y).toBeGreaterThanOrEqual(box.y);
    expect(reply.y + reply.height).toBeLessThanOrEqual(box.y + box.height);
  }
});

/** Presses Tab until `target` has focus, at most 80 times: the keyboard reaches it. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

/** Tab reaches each of `targets` in turn, and each shows a focus ring. */
async function reachEach(page: Page, targets: Locator[]) {
  for (const target of targets) {
    await tabTo(page, target);
    await expectRings(page, [target]);
  }
}

test.describe("the keyboard", () => {
  test("reaches a Lead's decision buttons, the Accept form's fields, submit and Cancel, and Approve and Reject, each with a focus ring", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const linus = await apiAs(baseURL, LINUS);
    const target = await linus.finding("@aws-sdk/client-cognito-identity");
    const reason = "Asked so the keyboard has a Proposal to reach";
    try {
      await proposeAsMargaret(baseURL, target.id, reason);
      await signIn(LINUS, BLUEBIRD);
      await focus(page, target);
      const c = card(page);
      await reachEach(page, [
        c.getByRole("button", { name: "Accept" }),
        c.getByRole("button", { name: "Mark False positive" }),
      ]);

      await c.getByRole("button", { name: "Accept" }).click();
      const form = c.getByRole("form", { name: "Accept" });
      await form
        .getByRole("textbox", { name: "Why accept this risk?" })
        .fill("Checked by keyboard");
      await form.getByLabel("Reopens on").fill(UNTIL);
      // Tab on from the card's ✕, just before the form: past the page's end, Firefox leaves the page, not wraps.
      await c.getByRole("button", { name: "Clear the focus" }).focus();
      await reachEach(page, [
        form.getByRole("textbox", { name: "Why accept this risk?" }),
        // The ring is read off the date input itself. In WebKit the keyboard focuses its inner fields, so the input
        // never matches :focus-visible; styles.css rings it through :focus-within, which this reads (failed in WebKit
        // before that rule, run 45488827212).
        form.getByLabel("Reopens on"),
        form.getByRole("button", { name: "Accept" }),
        form.getByRole("button", { name: "Cancel" }),
      ]);

      await form.getByRole("button", { name: "Cancel" }).click();
      const item = c.getByRole("listitem").filter({ hasText: reason });
      await reachEach(page, [
        item.getByRole("button", { name: "Approve" }),
        item.getByRole("button", { name: "Reject" }),
      ]);
    } finally {
      await linus.restore(target.id);
    }
  });

  test("reaches Mark moved's candidate and Cancel, each with a focus ring", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const target = await (
      await apiAs(baseURL, LINUS)
    ).finding("The agent can read .env files", "fixed");
    await signIn(LINUS, BLUEBIRD);
    await focus(page, target);
    await reachEach(page, [card(page).getByRole("button", { name: "Mark moved" })]);
    await card(page).getByRole("button", { name: "Mark moved" }).click();
    const form = card(page).getByRole("form", { name: "Mark moved" });
    await reachEach(page, [form.getByRole("radio"), form.getByRole("button", { name: "Cancel" })]);
  });
});

test.describe("at 390px", () => {
  test("a Lead's controls, the Accept form's and a Proposal's are each at least 44 by 44px", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const linus = await apiAs(baseURL, LINUS);
    const target = await linus.finding("@aws-sdk/client-cognito-identity");
    const reason = "Asked so a phone has a Proposal to measure";
    try {
      await proposeAsMargaret(baseURL, target.id, reason);
      await signIn(LINUS, BLUEBIRD);
      await focus(page, target, 390, 844);
      const c = card(page);
      const item = c.getByRole("listitem").filter({ hasText: reason });
      await expectTargets([
        c.getByRole("button", { name: "Accept" }),
        c.getByRole("button", { name: "Mark False positive" }),
        item.getByRole("button", { name: "Approve" }),
        item.getByRole("button", { name: "Reject" }),
      ]);

      await c.getByRole("button", { name: "Accept" }).click();
      const form = c.getByRole("form", { name: "Accept" });
      await expectTargets([
        form.getByRole("textbox", { name: "Why accept this risk?" }),
        form.getByLabel("Reopens on"),
        form.getByRole("button", { name: "Accept" }),
        form.getByRole("button", { name: "Cancel" }),
      ]);
    } finally {
      await linus.restore(target.id);
    }
  });

  test("Mark moved's candidate is a 44px-high target", async ({ page, signIn, baseURL }) => {
    const target = await (
      await apiAs(baseURL, LINUS)
    ).finding("The agent can read .env files", "fixed");
    await signIn(LINUS, BLUEBIRD);
    await focus(page, target, 390, 844);
    await card(page).getByRole("button", { name: "Mark moved" }).click();
    const form = card(page).getByRole("form", { name: "Mark moved" });
    // The radio's target is its whole row: the label it sits in.
    await expectTargets([form.locator("label.candidate")]);
  });
});

for (const width of [390, 1024, 1600]) {
  test(`with the Accept form open at ${width}px, nothing scrolls sideways`, async ({
    page,
    signIn,
    baseURL,
  }) => {
    const target = await (await apiAs(baseURL, LINUS)).finding("lodash 4.17.20");
    await signIn(LINUS, BLUEBIRD);
    await focus(page, target, width, 844);
    await card(page).getByRole("button", { name: "Accept" }).click();
    await expect(card(page).getByRole("form", { name: "Accept" })).toBeVisible();

    for (const selector of ["html", ".panel-body"]) {
      const { scroll, client } = await page
        .locator(selector)
        .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(scroll, selector).toBeLessThanOrEqual(client);
    }
  });
}
