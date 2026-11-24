// docs/design.md, Layout: the Findings page at 390, 1024 and 1600px, in light and dark, with the Ask Warden panel
// closed, floating and pinned (where pinning is offered). Nothing scrolls sideways;
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
      // The seed's longest title has a 41-character package name with no space in it.
      await expect(
        page.locator(".findings-table", { hasText: "@aws-sdk/client-cognito-identity-provider" }),
      ).toBeVisible();
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // The page follows the colour scheme: the body wears that scheme's --bg.
      const colours = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--bg)";
        document.body.append(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          bg,
          body: getComputedStyle(document.body).backgroundColor,
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
        };
      });
      expect(colours.body).toBe(colours.bg);
      expect(colours.dark).toBe(scheme === "dark");
    });
  }
}

/** The Ask Warden panel's states at each width: closed everywhere, open (full screen under 640px), pinned from 1100px. */
const PANEL_STATES: Record<(typeof WIDTHS)[number], ("closed" | "floating" | "pinned")[]> = {
  390: ["closed", "floating"],
  1024: ["closed", "floating"],
  1600: ["closed", "floating", "pinned"],
};

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    for (const state of PANEL_STATES[width]) {
      test(`at ${width}px in ${scheme}, with the panel ${state} and a Finding focused, nothing scrolls sideways`, async ({
        page,
      }) => {
        // Pinned at its widest, the page has the least room. Selecting a row opens a closed panel floating; the seed's
        // longest title has a 41-character package name with no space in it.
        await page.addInitScript(
          (stored) => localStorage.setItem("warden.askWardenPanel", stored),
          JSON.stringify({ mode: state === "pinned" ? "pinned" : "closed", width: 680 }),
        );
        await openAt(page, width, scheme);
        if (state !== "closed") {
          await page.locator(".finding-link", { hasText: "@aws-sdk" }).click();
          await expect(page.locator(".detail-card")).toBeVisible();
          await expect(page.locator(".ask-warden")).toHaveAttribute(
            "data-shown",
            state === "floating" && width < 640 ? "full-screen" : state,
          );
        }
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  }
}

/** Each journey card's left and top, rounded to whole pixels. */
const journeyBoxes = (page: Page) =>
  page.locator(".journey-card").evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }),
  );

// The Overview: closed everywhere, pinned where pinning is offered (from 1100px). The journey cards stack under a
// 640px column and sit three in a row from it.
const OVERVIEW_PANEL: Record<(typeof WIDTHS)[number], ("closed" | "pinned")[]> = {
  390: ["closed"],
  1024: ["closed"],
  1600: ["closed", "pinned"],
};

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    for (const state of OVERVIEW_PANEL[width]) {
      test(`Overview at ${width}px in ${scheme}, with the panel ${state}: nothing scrolls sideways, and the journey cards fit`, async ({
        page,
      }) => {
        await page.addInitScript(
          (stored) => localStorage.setItem("warden.askWardenPanel", stored),
          JSON.stringify({ mode: state, width: 680 }),
        );
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto("/overview");
        await expect(page.locator(".journey-card")).toHaveCount(3);
        await expect(page.locator(".trend-line")).toBeVisible();
        if (state === "pinned") {
          await expect(page.locator(".ask-warden")).toHaveAttribute("data-shown", "pinned");
        }

        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
        const main = await page.locator("main.page").boundingBox();
        expect(main!.width).toBeLessThanOrEqual(1480);

        const boxes = await journeyBoxes(page);
        if (width === 390) {
          expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
          expect(new Set(boxes.map((b) => b.top)).size).toBe(3);
        }
        if (width === 1600) {
          expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
          expect(new Set(boxes.map((b) => b.left)).size).toBe(3);
        }
      });
    }
  }
}

test("at 1100px with the panel pinned 680px wide, nothing scrolls sideways and the cards wrap to the page's column", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("warden.askWardenPanel", JSON.stringify({ mode: "pinned", width: 680 })),
  );
  await openAt(page, 1100, "light");
  await expect(page.locator(".ask-warden")).toHaveAttribute("data-shown", "pinned");
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  // A 420px column is a phone's: the cards stack, and the table drops its Asset column.
  const boxes = await cardBoxes(page);
  expect(new Set(boxes.map((b) => b.top)).size).toBe(5);
  expect(await visibleColumns(page)).toEqual(["Severity", "Finding", "Status"]);
});

test("at 390px, a title holding a 60-character word with no break in it still doesn't scroll sideways", async ({
  page,
}) => {
  await openAt(page, 390, "light");
  // No hyphen, slash or space: nothing the browser would break at on its own.
  await page
    .locator(".findings-table .finding-title")
    .first()
    .evaluate((title) => (title.textContent = `${"Unbroken".repeat(7)}Name`));
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

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
