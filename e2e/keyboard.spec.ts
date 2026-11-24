// docs/design.md, Accessibility floor, on the Findings page and its Ask Warden panel: the keyboard reaches each card,
// filter tab and row (the button in its title cell), then the panel's controls, in order, and leaves them; focus shows a
// visible ring; and touch targets are at least 44 by 44px at phone width.
import type { Page } from "@playwright/test";
import { expectRings, expectTargets } from "./a11y.ts";
import { expect, GRACE, test } from "./session.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn(GRACE);
});

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/findings");
  await expect(page.locator(".findings-table tbody tr")).toHaveCount(7);
  await expect(page.locator(".level-line")).toBeVisible();
}

/** What has focus, as a short name: a card's title, a tab's group and word, a row's title, or the tag. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.classList.contains("finding-card"))
      return `card:${el.querySelector(".card-title")?.textContent}`;
    if (el.classList.contains("filter-tab")) {
      return `tab:${el.closest("[role=group]")?.getAttribute("aria-label")}:${el.textContent}`;
    }
    if (el.classList.contains("finding-link")) {
      return `row:${el.querySelector(".finding-title")?.textContent}`;
    }
    const label = el.getAttribute("aria-label");
    return `${el.tagName.toLowerCase()}:${label ?? el.textContent}`;
  });

/** Presses Tab `times` times from where focus is, and names what each press reached. */
async function tabThrough(page: Page, times: number) {
  const reached: string[] = [];
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Tab");
    reached.push(await focused(page));
  }
  return reached;
}

test("Tab reaches the Level line's link, each card, then each filter tab, then each row, in order, then the closed panel's button, and leaves", async ({
  page,
}) => {
  await open(page, 1024);
  await page.getByRole("button", { name: "Sign out" }).focus();

  expect(await tabThrough(page, 1)).toEqual(["a:see the journey"]);
  const reached = await tabThrough(page, 5 + 14 + 7 + 2);

  const cards = await page.locator(".finding-card .card-title").allTextContents();
  const tabs = await page
    .locator(".filter-tab")
    .evaluateAll((all) =>
      all.map(
        (t) => `tab:${t.closest("[role=group]")?.getAttribute("aria-label")}:${t.textContent}`,
      ),
    );
  const rows = await page.locator(".findings-table .finding-title").allTextContents();
  expect(reached.slice(0, 5)).toEqual(cards.map((title) => `card:${title}`));
  expect(reached.slice(5, 19)).toEqual(tabs);
  expect(reached.slice(19, 26)).toEqual(rows.map((title) => `row:${title}`));
  // After the last row, the closed Ask Warden panel's button; then focus leaves the page's controls.
  expect(reached.slice(26)).toEqual(["button:Ask Warden", "body"]);
});

test("Tab reaches the open panel's controls after the page's, in order, and then leaves them", async ({
  page,
}) => {
  await open(page, 1400);
  const lastRow = page.locator(".findings-table .finding-link").last();
  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expect(panel).toHaveAttribute("data-shown", "floating");

  await lastRow.focus();
  // Grace is a Member: an Open Finding's card offers her its Propose buttons (#59).
  expect(await tabThrough(page, 8)).toEqual([
    "button:Pin",
    "button:Close Ask Warden",
    "button:Clear the focus",
    "button:Propose accepting",
    "button:Propose False positive",
    "input:Message",
    "button:Send",
    "body",
  ]);

  await panel.getByRole("button", { name: "Pin" }).click();
  await expect(panel).toHaveAttribute("data-shown", "pinned");
  await lastRow.focus();
  expect(await tabThrough(page, 9)).toEqual([
    "div:Resize Ask Warden",
    "button:Unpin",
    "button:Close Ask Warden",
    "button:Clear the focus",
    "button:Propose accepting",
    "button:Propose False positive",
    "input:Message",
    "button:Send",
    "body",
  ]);
});

test("a focused card, filter tab, row, Level line link and Overview link each show a visible ring", async ({
  page,
}) => {
  await open(page, 1024);
  await expectRings(page, [
    page.getByRole("link", { name: "see the journey" }),
    page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Overview" }),
    page.locator(".finding-card").first(),
    page.locator(".filter-tab").nth(2),
    page.locator(".findings-table .finding-link").nth(1),
  ]);
});

test("the panel's button, Pin, ✕, divider, card's ✕, a Member's Propose buttons, input and Send each show a visible ring", async ({
  page,
}) => {
  await open(page, 1400);
  await expectRings(page, [page.getByRole("button", { name: "Ask Warden" })]);

  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expectRings(page, [
    panel.getByRole("button", { name: "Pin" }),
    panel.getByRole("button", { name: "Close Ask Warden" }),
    panel.getByRole("button", { name: "Clear the focus" }),
    panel.getByRole("button", { name: "Propose accepting" }),
    panel.getByRole("button", { name: "Propose False positive" }),
    panel.getByRole("textbox", { name: "Message" }),
    panel.getByRole("button", { name: "Send" }),
  ]);

  await panel.getByRole("button", { name: "Pin" }).click();
  await expectRings(page, [panel.getByRole("separator", { name: "Resize Ask Warden" })]);
});

test("at 390px, every card, filter tab, row, page link and the Level line's link is at least 44 by 44px", async ({
  page,
}) => {
  await open(page, 390);
  const targets = page.locator(
    ".finding-card, .filter-tab, .findings-table .finding-link, .page-links a, .app-header button, .level-line a",
  );
  const sizes = await targets.evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect();
      return { what: el.textContent?.slice(0, 30), width: box.width, height: box.height };
    }),
  );
  expect(sizes.length).toBe(5 + 14 + 7 + 3 + 1 + 1);
  for (const size of sizes) {
    expect(size.width, size.what).toBeGreaterThanOrEqual(44);
    expect(size.height, size.what).toBeGreaterThanOrEqual(44);
  }
});

test("at 390px, the panel's button, ✕, card's ✕, a Member's Propose buttons, input and Send are each at least 44 by 44px", async ({
  page,
}) => {
  await open(page, 390);
  await expectTargets([page.getByRole("button", { name: "Ask Warden" })]);

  // Pin and the divider aren't offered under 1100px: an open panel fills the screen.
  await page.locator(".finding-card").first().click();
  const panel = page.getByRole("complementary", { name: "Ask Warden" });
  await expect(panel).toHaveAttribute("data-shown", "full-screen");
  await expect(panel.getByRole("button", { name: "Pin" })).toHaveCount(0);
  await expect(panel.getByRole("separator")).toHaveCount(0);
  await expectTargets([
    panel.getByRole("button", { name: "Close Ask Warden" }),
    panel.getByRole("button", { name: "Clear the focus" }),
    panel.getByRole("button", { name: "Propose accepting" }),
    panel.getByRole("button", { name: "Propose False positive" }),
    panel.getByRole("textbox", { name: "Message" }),
    panel.getByRole("button", { name: "Send" }),
  ]);
});
