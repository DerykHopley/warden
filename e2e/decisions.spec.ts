// Story 4 in the detail card (docs/design.md: Detail card, Chat message, Accessibility floor): a Lead's decisions end
// to end, a Member's Proposal that a Lead approves, the chat keeping its newest message in view, and the card's
// controls by keyboard, at phone size and without sideways scroll. Every test reads Bluebird, which no other browser
// test reads, and leaves each Finding with its seeded Status. The words, the bodies sent and each refusal are
// dashboard/test/DetailCard.test.tsx's.
import type { Locator, Page } from "@playwright/test";
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

/** A far Until, so every run's accept is in the future whatever the day. */
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
  return {
    call,
    async finding(titleStart: string, status = "open"): Promise<FindingRow> {
      const { findings } = (await (await call("/api/findings")).json()) as {
        findings: FindingRow[];
      };
      const found = findings.find((f) => f.title.startsWith(titleStart) && f.status === status);
      if (found === undefined) throw new Error(`no ${status} Finding "${titleStart}…" in Bluebird`);
      return found;
    },
  };
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

test("story 4: Linus accepts an Open Finding, then reopens it; the card, the table and its history follow", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn(LINUS, BLUEBIRD);
  const api = await apiAs(baseURL, LINUS);
  const target = await api.finding("lodash 4.17.20");
  await focus(page, target);
  const statusCell = rowById(page, target.id).locator("td").last();

  await card(page).getByRole("button", { name: "Accept" }).click();
  const accept = card(page).getByRole("form", { name: "Accept" });
  await accept.getByRole("textbox", { name: "Reason" }).fill("Only a dev dependency");
  await accept.getByLabel("Until").fill(UNTIL);
  await accept.getByRole("button", { name: "Accept" }).click();

  await expect(card(page).getByRole("status")).toHaveText(/^Accepted until /);
  await expect(card(page).locator(".detail-status")).toContainText("Accepted");
  await expect(statusCell).toHaveText("Accepted");

  await card(page).getByRole("button", { name: "Reopen" }).click();
  const reopen = card(page).getByRole("form", { name: "Reopen" });
  await reopen.getByRole("textbox", { name: "Reason" }).fill("The dev server ships it after all");
  await reopen.getByRole("button", { name: "Reopen" }).click();

  await expect(card(page).getByRole("status")).toHaveText("Reopened.");
  await expect(card(page).locator(".detail-status")).toContainText("Open");
  await expect(statusCell).toHaveText("Open");

  const { history } = (await (await api.call(`/api/findings/${target.id}/history`)).json()) as {
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
});

test("story 4: Margaret proposes a False positive and sees it as hers; Linus approves it, and the card reads False positive", async ({
  page,
  signIn,
  baseURL,
}) => {
  const target = await (await apiAs(baseURL, LINUS)).finding("The disk isn't encrypted");
  const reason = "The laptop is a kiosk with nothing on it";
  try {
    await signIn(MARGARET, BLUEBIRD);
    await focus(page, target);
    await card(page).getByRole("button", { name: "Propose False positive" }).click();
    const form = card(page).getByRole("form", { name: "Propose False positive" });
    await form.getByRole("textbox", { name: "Reason" }).fill(reason);
    await form.getByRole("button", { name: "Propose" }).click();

    await expect(card(page).getByRole("status")).toHaveText(
      "Proposal sent. A Lead or an Admin decides.",
    );
    const mine = card(page).getByRole("listitem").filter({ hasText: reason });
    await expect(mine).toContainText("Asked by you");
    await expect(
      card(page).getByRole("button", {
        name: /^(Accept|Mark False positive|Reopen|Approve|Reject)$/,
      }),
    ).toHaveCount(0);

    await signIn(LINUS, BLUEBIRD);
    await focus(page, target);
    const hers = card(page).getByRole("listitem").filter({ hasText: reason });
    await expect(hers).toContainText("Asked by Margaret Hamilton");
    await hers.getByRole("button", { name: "Approve" }).click();

    await expect(card(page).getByRole("status")).toHaveText("Proposal approved.");
    await expect(hers).toHaveCount(0);
    await expect(card(page).locator(".detail-status")).toContainText("False positive");
  } finally {
    // Back to its seeded Status, so a rerun starts from the same data.
    await (
      await apiAs(baseURL, LINUS)
    ).call(`/api/findings/${target.id}/reopen`, { reason: "Back to the seeded Status" });
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

/** Presses Tab until `target` has focus (at most 80 times), then checks its focus ring shows. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  const ring = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);
}

test.describe("the keyboard", () => {
  test("reaches a Lead's decision buttons, each form field, the submit and Cancel, Approve and Reject, each with a focus ring", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const target = await (await apiAs(baseURL, LINUS)).finding("@aws-sdk/client-cognito-identity");
    const reason = "Asked so the keyboard has a Proposal to reach";
    const asked = await (
      await apiAs(baseURL, MARGARET)
    ).call(`/api/findings/${target.id}/proposals`, { decision: "mark_false_positive", reason });
    expect(asked.status).toBe(201);

    await signIn(LINUS, BLUEBIRD);
    await focus(page, target);
    const c = card(page);
    await tabTo(page, c.getByRole("button", { name: "Accept" }));
    await tabTo(page, c.getByRole("button", { name: "Mark False positive" }));
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    const form = c.getByRole("form", { name: "Accept" });
    const reasonField = form.getByRole("textbox", { name: "Reason" });
    await expect(reasonField).toBeFocused();
    await tabTo(page, reasonField);
    await page.keyboard.type("Checked by keyboard");
    await tabTo(page, form.getByLabel("Until"));
    await form.getByLabel("Until").fill(UNTIL);
    await tabTo(page, form.getByRole("button", { name: "Accept" }));
    await tabTo(page, form.getByRole("button", { name: "Cancel" }));
    await page.keyboard.press("Enter");
    await expect(c.getByRole("button", { name: "Accept" })).toBeFocused();

    const item = c.getByRole("listitem").filter({ hasText: reason });
    await tabTo(page, item.getByRole("button", { name: "Approve" }));
    await tabTo(page, item.getByRole("button", { name: "Reject" }));
    await page.keyboard.press("Enter");
    const reject = item.getByRole("form", { name: "Reject" });
    await expect(reject.getByRole("textbox", { name: "Reason" })).toBeFocused();
    await page.keyboard.type("Not a False positive");
    await tabTo(page, reject.getByRole("button", { name: "Reject" }));
    await page.keyboard.press("Enter");
    await expect(c.getByRole("status")).toHaveText("Proposal rejected.");
  });

  test("reaches Mark moved's candidate", async ({ page, signIn, baseURL }) => {
    const target = await (
      await apiAs(baseURL, LINUS)
    ).finding("The agent can read .env files", "fixed");
    await signIn(LINUS, BLUEBIRD);
    await focus(page, target);
    const c = card(page);
    await tabTo(page, c.getByRole("button", { name: "Mark moved" }));
    await page.keyboard.press("Enter");
    const form = c.getByRole("form", { name: "Mark moved" });
    await tabTo(page, form.getByRole("radio"));
    await tabTo(page, form.getByRole("button", { name: "Cancel" }));
    await page.keyboard.press("Enter");
    await expect(c.getByRole("button", { name: "Mark moved" })).toBeFocused();
  });

  test("reaches a Member's Propose buttons", async ({ page, signIn, baseURL }) => {
    const target = await (await apiAs(baseURL, LINUS)).finding("minimist 1.2.5");
    await signIn(MARGARET, BLUEBIRD);
    await focus(page, target);
    await tabTo(page, card(page).getByRole("button", { name: "Propose accepting" }));
    await tabTo(page, card(page).getByRole("button", { name: "Propose False positive" }));
  });
});

/** Fails unless each of `controls` is at least 44 by 44px. */
async function expectTargets(controls: Locator[]) {
  for (const control of controls) {
    const box = (await control.boundingBox())!;
    expect(box.width, String(control)).toBeGreaterThanOrEqual(44);
    expect(box.height, String(control)).toBeGreaterThanOrEqual(44);
  }
}

test.describe("at 390px", () => {
  test("a Lead's controls, the Accept form's and a Proposal's are each at least 44 by 44px", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const target = await (await apiAs(baseURL, LINUS)).finding("@aws-sdk/client-cognito-identity");
    const reason = "Asked so a phone has a Proposal to measure";
    await (
      await apiAs(baseURL, MARGARET)
    ).call(`/api/findings/${target.id}/proposals`, { decision: "mark_false_positive", reason });
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
      form.getByRole("textbox", { name: "Reason" }),
      form.getByLabel("Until"),
      form.getByRole("button", { name: "Accept" }),
      form.getByRole("button", { name: "Cancel" }),
    ]);

    // Leave no Proposal pending.
    await form.getByRole("button", { name: "Cancel" }).click();
    await item.getByRole("button", { name: "Reject" }).click();
    await item.getByRole("textbox", { name: "Reason" }).fill("Measured");
    await item.getByRole("button", { name: "Reject" }).click();
    await expect(c.getByRole("status")).toHaveText("Proposal rejected.");
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

  test("a Member's Propose buttons are each at least 44 by 44px", async ({
    page,
    signIn,
    baseURL,
  }) => {
    const target = await (await apiAs(baseURL, LINUS)).finding("minimist 1.2.5");
    await signIn(MARGARET, BLUEBIRD);
    await focus(page, target, 390, 844);
    await expectTargets([
      card(page).getByRole("button", { name: "Propose accepting" }),
      card(page).getByRole("button", { name: "Propose False positive" }),
    ]);
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 1024, 1600]) {
    test(`with the Accept form open at ${width}px in ${colorScheme}, nothing scrolls sideways`, async ({
      page,
      signIn,
      baseURL,
    }) => {
      await page.emulateMedia({ colorScheme });
      const target = await (await apiAs(baseURL, LINUS)).finding("lodash 4.17.20");
      await signIn(LINUS, BLUEBIRD);
      await focus(page, target, width, 844);
      await card(page).getByRole("button", { name: "Accept" }).click();
      await expect(card(page).getByRole("form", { name: "Accept" })).toBeVisible();

      const sideways = (selector: string) =>
        page
          .locator(selector)
          .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      for (const selector of ["html", ".panel-body"]) {
        const { scroll, client } = await sideways(selector);
        expect(scroll, selector).toBeLessThanOrEqual(client);
      }
    });
  }
}
