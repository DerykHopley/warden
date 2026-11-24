// docs/design.md, Layout: the Findings page at 390, 1024 and 1600px, in light and dark. Nothing scrolls sideways;
// under 640px one column and a table of Severity, Finding and Status; from 640 to 1100px the cards wrap two or three to
// a row; from 1100px five sit in a row; content stays within about 1480px, centred.
import type { Page } from "@playwright/test";
import { expect, GRACE, test } from "./session.ts";

const WIDTHS = [390, 1024, 1600] as const;
const SCHEMES = ["light", "dark"] as const;

test.beforeEach(async ({ signIn }) => {
  await signIn(GRACE);
});

async function openAt(page: Page, width: number, colorScheme: "light" | "dark") {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  await page.goto("/findings");
  await expect(page.locator(".finding-card")).toHaveCount(5);
  await expect(page.locator(".findings-table tbody tr")).toHaveCount(7);
}

/** Each card's left and top, rounded to whole pixels. */
const cardBoxes = (page: Page) =>
  page.locator(".finding-card").evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }),
  );

const visibleColumns = (page: Page) =>
  page
    .locator(".findings-table thead th")
    .evaluateAll((headers) =>
      headers.filter((th) => getComputedStyle(th).display !== "none").map((th) => th.textContent),
    );

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`at ${width}px in ${scheme}, nothing scrolls sideways`, async ({ page }) => {
      await openAt(page, width, scheme);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // The page follows the colour scheme: the dark tokens apply in dark.
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).toBe(scheme === "light" ? "rgb(247, 245, 240)" : "rgb(29, 28, 26)");
    });
  }
}

test("under 640px: the cards stack in one column, and the table shows Severity, Finding and Status", async ({
  page,
}) => {
  await openAt(page, 390, "light");
  const boxes = await cardBoxes(page);
  expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
  expect(boxes.map((b) => b.top)).toEqual([...boxes.map((b) => b.top)].sort((a, b) => a - b));
  expect(new Set(boxes.map((b) => b.top)).size).toBe(5);
  expect(await visibleColumns(page)).toEqual(["Severity", "Finding", "Status"]);
});

test("at 1024px: the cards wrap two or three to a row, and the table shows all four columns", async ({
  page,
}) => {
  await openAt(page, 1024, "light");
  const boxes = await cardBoxes(page);
  const firstRow = boxes.filter((b) => b.top === boxes[0]!.top);
  expect([2, 3]).toContain(firstRow.length);
  expect(await visibleColumns(page)).toEqual(["Severity", "Finding", "Asset", "Status"]);
});

test("at 1600px: five cards sit in one row, and the content stays within 1480px, centred", async ({
  page,
}) => {
  await openAt(page, 1600, "light");
  const boxes = await cardBoxes(page);
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
  const main = await page.locator("main.page").boundingBox();
  expect(main!.width).toBeLessThanOrEqual(1480);
  const right = 1600 - (main!.x + main!.width);
  expect(Math.abs(main!.x - right)).toBeLessThanOrEqual(1);
});
