// docs/design.md, Layout: the Findings page at 390, 1024 and 1600px, in light and dark, with the Ask Warden panel
// closed, floating and pinned (where pinning is offered). Nothing scrolls sideways;
// under 640px one column and a table of Severity, Finding and Status; from 640 to 1100px the cards wrap two or three to
// a row; from 1100px five sit in a row; content stays within about 1480px, centred.
//
// Every page, opened directly at each width and scheme, scrolls nothing sideways: Products in Cedar (its Products
// stay out of Acme's Findings counts), Setup as Ada, the rest as Grace in Acme.
import type { Locator, Page } from "@playwright/test";
import { expectNoSidewaysScroll, expectRings, expectTargets } from "./a11y.ts";
import { cedarCveFinding, openCveCard } from "./cedar-cve.ts";
import {
  ACME,
  ADA,
  CEDAR,
  CHAT_ASSISTANT,
  ensureProduct,
  expect,
  GRACE,
  HEDY,
  KATHERINE,
  signInEachTest,
  SIGNS_IN_ITSELF,
  test,
  type Person,
  type Team,
} from "./session.ts";

const WIDTHS = [390, 1024, 1600] as const;
const SCHEMES = ["light", "dark"] as const;

signInEachTest(GRACE);

test.beforeAll(async () => {
  await ensureProduct(CEDAR, CHAT_ASSISTANT);
});

/**
 * Who opens each page, and what it shows once it has loaded, so the check runs against its content, not its waiting
 * line. /findings and /overview are opened directly at each width and scheme by their own tests below.
 */
const PAGES: { path: string; person: Person; team: Team; loaded: (page: Page) => Locator }[] = [
  // A Member's landing page is Findings.
  {
    path: "/",
    person: GRACE,
    team: ACME,
    loaded: (page) => page.locator(".findings-table tbody tr").first(),
  },
  {
    path: "/products",
    person: KATHERINE,
    team: CEDAR,
    loaded: (page) => page.locator(".product").first(),
  },
  {
    path: "/people",
    person: GRACE,
    team: ACME,
    loaded: (page) => page.locator(".people tbody tr").first(),
  },
];

for (const { path, person, team, loaded } of PAGES) {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(
        `${path} opened directly at ${width}px in ${scheme}: nothing scrolls sideways`,
        SIGNS_IN_ITSELF,
        async ({ page, signIn }) => {
          await signIn(person, team);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(path);
          await expect(loaded(page)).toBeVisible();
          await expectNoSidewaysScroll(page);
        },
      );
    }
  }
}

test(
  "Products under 640px: each Product's parts and dependency rows stack in one column",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await signIn(KATHERINE, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/products");
    const entry = page.locator(".product", { hasText: "Chat assistant" });
    await expect(entry).toBeVisible();
    const lefts = (selector: string) =>
      entry
        .locator(selector)
        .evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(await lefts(".product-part")).size).toBe(1);
    expect(new Set(await lefts(".dependency:first-child > *")).size).toBe(1);

    await page.setViewportSize({ width: 1024, height: 900 });
    expect(new Set(await lefts(".product-part")).size).toBe(2);
  },
);

/** Opens Edit's form on Chat assistant (two Repo URLs, two framework rows) as Cedar's Admin. */
async function openProductForm(page: Page) {
  await page.goto("/products");
  await page.getByRole("button", { name: "Edit Chat assistant" }).click();
  const form = page.getByRole("form", { name: "Edit Chat assistant" });
  await expect(form.locator(".dependency-fields")).toHaveCount(2);
  await expect(form.getByRole("textbox", { name: /^Repo URL/ })).toHaveCount(2);
  return form;
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(
      `Products at ${width}px in ${scheme}, with the Product form open: nothing scrolls sideways`,
      SIGNS_IN_ITSELF,
      async ({ page, signIn }) => {
        await signIn(HEDY, CEDAR);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await openProductForm(page);
        await expectNoSidewaysScroll(page);
      },
    );
  }
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(
      `Products at ${width}px in ${scheme}, with the delete confirm open: nothing scrolls sideways`,
      SIGNS_IN_ITSELF,
      async ({ page, signIn }) => {
        await signIn(HEDY, CEDAR);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto("/products");
        await page.getByRole("button", { name: "Delete Chat assistant" }).click();
        await expect(
          page.getByRole("group", { name: "Delete Chat assistant? Its CVE Findings turn Fixed." }),
        ).toBeVisible();
        await expectNoSidewaysScroll(page);
      },
    );
  }
}

test(
  "the Product form under 640px: a framework row's controls stack in one column; from 640px they sit side by side",
  SIGNS_IN_ITSELF,
  async ({ page, signIn }) => {
    await signIn(HEDY, CEDAR);
    await page.setViewportSize({ width: 390, height: 900 });
    const form = await openProductForm(page);
    const lefts = () =>
      form
        .locator(".dependency-fields")
        .first()
        .locator(":scope > *")
        .evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(await lefts()).size).toBe(1);

    await page.setViewportSize({ width: 1024, height: 900 });
    expect(new Set(await lefts()).size).toBe(5);
  },
);

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
      await expectNoSidewaysScroll(page);
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
        await expectNoSidewaysScroll(page);
      });
    }
  }
}

// A Cedar CVE Finding's card, its Patch section loaded (the assessment's reason, reasons and links are the card's
// longest text): floating at each width, and pinned where pinning is offered.
for (const width of WIDTHS) {
  for (const state of PANEL_STATES[width].filter((s) => s !== "closed")) {
    test(
      `at ${width}px, with the panel ${state} and a CVE Finding's Patch section shown, nothing scrolls sideways`,
      SIGNS_IN_ITSELF,
      async ({ page, signIn }) => {
        const finding = await cedarCveFinding();
        await signIn(HEDY, CEDAR);
        await page.addInitScript(
          (stored) => localStorage.setItem("warden.askWardenPanel", stored),
          JSON.stringify({ mode: state === "pinned" ? "pinned" : "closed", width: 680 }),
        );
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/findings");
        await openCveCard(page, finding);
        await expect(page.locator(".ask-warden")).toHaveAttribute(
          "data-shown",
          state === "floating" && width < 640 ? "full-screen" : state,
        );
        await expectNoSidewaysScroll(page);
      },
    );
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

        await expectNoSidewaysScroll(page);
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
  await expectNoSidewaysScroll(page);
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
  await expectNoSidewaysScroll(page);
});

// The header's width depends on the fonts the machine has: four page links fitted with this machine's Noto Sans and
// scrolled 9px sideways with the CI runner's DejaVu Sans (#141). Wider letters stand in for a wider font, so this test
// fails on any machine while the header can't wrap.
test("at 390px with the header's text a tenth of an em wider per letter, the header wraps instead of scrolling sideways, and each page link stays 44 by 44px", async ({
  page,
}) => {
  await openAt(page, 390, "light");
  await page.addStyleTag({ content: ".app-header { letter-spacing: 0.1em; }" });
  const clientWidth = await expectNoSidewaysScroll(page);
  const links = page.getByRole("navigation", { name: "Pages" }).getByRole("link");
  await expect(links).toHaveCount(5);
  for (const box of await links.evaluateAll((all) => all.map((a) => a.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.right).toBeLessThanOrEqual(clientWidth);
  }
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

// Setup and its GitHub pages, the read app's and the write app's (#224, story 5), as an Admin sees them: both apps'
// settings, the Team's write grant, the Team's repos with their last Scans (one ref long enough to wrap) and a refused
// Scan now are faked in the browser, and each callback page, opened with no sign-in kept, shows its refusal.
const SETUP_PAGES: { path: string; ready: (page: Page) => Locator }[] = [
  { path: "/setup", ready: (page) => page.getByRole("link", { name: "Install the write app" }) },
  {
    path: "/setup/github?installation_id=42&setup_action=install",
    ready: (page) => page.getByRole("button", { name: "Sign in with GitHub" }),
  },
  {
    path: "/setup/github/callback?code=the-code&state=the-state",
    ready: (page) => page.getByRole("link", { name: "Back to Setup" }),
  },
  {
    path: "/setup/github/write?installation_id=42&setup_action=install",
    ready: (page) => page.getByRole("button", { name: "Sign in with GitHub" }),
  },
  {
    path: "/setup/github/write/callback?code=the-code&state=the-state",
    ready: (page) => page.getByRole("link", { name: "Back to Setup" }),
  },
];

for (const { path, ready } of SETUP_PAGES) {
  for (const width of WIDTHS) {
    test(
      `${path} at ${width}px: nothing scrolls sideways, and its links and buttons are 44px targets with a focus ring`,
      SIGNS_IN_ITSELF,
      async ({ page, signIn }) => {
        await signIn(ADA);
        await page.route("**/api/github/app", (route) =>
          route.fulfill({ json: { slug: "warden-reader", client_id: "Iv23li-e2e-client" } }),
        );
        await page.route("**/api/github/write-app", (route) =>
          route.fulfill({ json: { slug: "warden-writer", client_id: "Iv23li-e2e-writer" } }),
        );
        await page.route("**/api/github/write-grant", (route) =>
          route.fulfill({
            json: {
              installations: [
                {
                  installation_id: 77,
                  granted_by: "user_ada",
                  granted_at: "2026-11-26T09:14:00.000Z",
                },
              ],
            },
          }),
        );
        // Until Scan now is clicked, the long ref's last Scan failed and the other was never scanned; after it, the
        // long ref's is running.
        let started = false;
        await page.route("**/api/repos", (route) =>
          route.fulfill({
            json: {
              repos: [
                listedRepo(`acme/${"long-repo-name".repeat(6)}`, started ? "running" : "failed"),
                listedRepo("acme/web", null),
              ],
            },
          }),
        );
        await page.route("**/api/scans", (route) => {
          started = true;
          return route.fulfill({ status: 502, json: { error: "The Scan couldn't be started" } });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(ready(page)).toBeVisible();
        if (path === "/setup") {
          await expect(page.locator(".repo-list li")).toHaveCount(2);
          await expect(page.getByText(/^Failed, /)).toBeVisible();
          await expect(page.getByText("Never scanned")).toBeVisible();
          await expect(page.getByRole("link", { name: "Install the GitHub app" })).toBeVisible();
          await expect(page.getByText(/^Write access granted: installation 77, /)).toBeVisible();
          // The write app answers here, so its how-to starts closed: open it, so its URLs are measured too.
          await page.getByText("How to set up the write app").click();
          await expect(
            page.getByRole("heading", { name: "Register the app on GitHub" }),
          ).toBeVisible();
        }

        await expectNoSidewaysScroll(page);
        const targets = await page.locator("main.page").locator("a, button, summary").all();
        expect(targets.length).toBeGreaterThan(0);
        await expectTargets(targets);
        await expectRings(page, targets);

        if (path === "/setup") {
          // The refusal line, and the button beside "A Scan is under way.", at this width too. Their words and the
          // button's state are Setup.test.tsx's.
          const scanNow = page.getByRole("button", { name: "Scan now" });
          await scanNow.click();
          await expect(page.getByRole("alert")).toBeVisible();
          await expect(page.getByText("A Scan is under way.")).toBeVisible();
          await expectNoSidewaysScroll(page);
          await expectTargets([scanNow]);
        }
      },
    );
  }
}

/** One of `GET /api/repos`'s repos, with its last Scan in `state` (null: never scanned). */
function listedRepo(name: string, state: "running" | "failed" | null) {
  const ref = `https://github.com/${name}`;
  return {
    asset: { kind: "repo", ref },
    installation_id: 42,
    listed_at: "2026-11-25T09:00:00.000Z",
    last_scan:
      state === null
        ? null
        : {
            id: "0b6f1e9c-2d1f-4c55-9a3e-7f1d2c3b4a5e",
            module: "guard",
            state,
            assets: [{ kind: "repo", ref }],
            rules: ["guard/secret-in-repo"],
            queued_at: "2026-11-25T09:00:00.000Z",
            started_at: "2026-11-25T09:00:20.000Z",
            ended_at: state === "failed" ? "2026-11-25T09:14:00.000Z" : null,
          },
  };
}
