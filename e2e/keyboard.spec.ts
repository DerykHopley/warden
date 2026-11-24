// docs/design.md, Accessibility floor, on the Findings page: the keyboard reaches each card, filter tab and row (the
// button in its title cell) in order and leaves them, focus shows a visible ring, and touch targets are at least 44 by
// 44px at phone width.
import type { Locator, Page } from "@playwright/test";
import { expect, GRACE, test } from "./session.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn(GRACE);
});

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/findings");
  await expect(page.locator(".findings-table tbody tr")).toHaveCount(7);
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
    return `${el.tagName.toLowerCase()}:${el.textContent}`;
  });

test("Tab reaches each card, then each filter tab, then each row, in order, and then leaves them", async ({
  page,
}) => {
  await open(page, 1024);
  await page.getByRole("button", { name: "Sign out" }).focus();

  const reached: string[] = [];
  for (let i = 0; i < 5 + 14 + 7 + 1; i++) {
    await page.keyboard.press("Tab");
    reached.push(await focused(page));
  }

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
  // After the last row, focus leaves the page's controls.
  expect(reached[26]).toBe("body");
});

test("a focused card, filter tab and row each show a visible ring", async ({ page }) => {
  await open(page, 1024);
  const ring = async (target: Locator) => {
    await target.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    return target.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
  };
  for (const target of [
    page.locator(".finding-card").first(),
    page.locator(".filter-tab").nth(2),
    page.locator(".findings-table .finding-link").nth(1),
  ]) {
    const { style, width } = await ring(target);
    expect(style).toBe("solid");
    expect(width).toBeGreaterThanOrEqual(2);
  }
});

test("at 390px, every card, filter tab, row and page link is at least 44 by 44px", async ({
  page,
}) => {
  await open(page, 390);
  const targets = page.locator(
    ".finding-card, .filter-tab, .findings-table .finding-link, .page-links a, .app-header button",
  );
  const sizes = await targets.evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect();
      return { what: el.textContent?.slice(0, 30), width: box.width, height: box.height };
    }),
  );
  expect(sizes.length).toBe(5 + 14 + 7 + 2 + 1);
  for (const size of sizes) {
    expect(size.width, size.what).toBeGreaterThanOrEqual(44);
    expect(size.height, size.what).toBeGreaterThanOrEqual(44);
  }
});
