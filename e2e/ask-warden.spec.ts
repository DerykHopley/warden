// The Ask Warden panel (docs/design.md: Side panel, Layout, Motion): its starting state by window width, floating and
// Esc, full screen on a phone, pinning and the divider, a person's choice kept over a reload, and stories 9 and 3 end
// to end: a Member's detail card for a chosen Finding, and the Proposal she made in it.
import type { Page } from "@playwright/test";
import { ACME, expect, GRACE, sessionToken, signingKey, test } from "./session.ts";

const panel = (page: Page) => page.getByRole("complementary", { name: "Ask Warden" });
const askWarden = (page: Page) => page.getByRole("button", { name: /^Ask Warden/ });
const divider = (page: Page) => page.getByRole("separator", { name: "Resize Ask Warden" });

test.beforeEach(async ({ signIn }) => {
  await signIn(GRACE);
});

async function openAt(page: Page, width: number, url = "/findings") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await expect(page.locator(".findings-table tbody tr")).toHaveCount(7);
}

const panelWidth = async (page: Page) => (await panel(page).boundingBox())!.width;

/** Resolves once the floating panel's slide has ended: its box moves until then. */
const slidIn = (page: Page) =>
  panel(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

/** The viewport's right edge, left of any scroll bar: where a pinned panel ends. */
const viewportRight = (page: Page) => page.evaluate(() => document.documentElement.clientWidth);

/** Pins the panel at 1400px wide, from the closed button. */
async function pinnedAt1400(page: Page) {
  await openAt(page, 1400);
  await askWarden(page).click();
  await panel(page).getByRole("button", { name: "Pin" }).click();
  await expect(panel(page)).toHaveAttribute("data-shown", "pinned");
}

// The starting state by width: closed at 1024px (the floating test) and at 1400px (pinnedAt1400) opens from the
// button; pinned at 1700px is story 9's. Each width's rule is panel.test.ts's.

test("opened at 1024px, the panel floats over the page below the header; Esc closes it and puts focus back on its button", async ({
  page,
}) => {
  await openAt(page, 1024);
  await askWarden(page).click();

  await expect(panel(page)).toHaveAttribute("data-shown", "floating");
  await slidIn(page);
  const box = (await panel(page).boundingBox())!;
  const main = (await page.locator("main.page").boundingBox())!;
  // Over the page: the page keeps its width, and the panel overlaps its right side.
  expect(main.x + main.width).toBeGreaterThan(box.x);
  expect(await panel(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  // Below the header: Sign out is still the element under its own centre, and takes a click.
  const header = (await page.getByRole("banner").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  const signOut = page.getByRole("button", { name: "Sign out" });
  const at = (await signOut.boundingBox())!;
  expect(
    await signOut.evaluate((el, point) => document.elementFromPoint(point.x, point.y) === el, {
      x: at.x + at.width / 2,
      y: at.y + at.height / 2,
    }),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(askWarden(page)).toBeFocused();
});

test("under 640px, opening the panel fills the screen", async ({ page }) => {
  await openAt(page, 390);
  await askWarden(page).click();
  await expect(panel(page)).toHaveAttribute("data-shown", "full-screen");
  expect(await panel(page).boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: await viewportRight(page),
    height: await page.evaluate(() => document.documentElement.clientHeight),
  });
});

test("Pin is offered at 1100px and wider, and not at 1024px", async ({ page }) => {
  await openAt(page, 1024);
  await askWarden(page).click();
  await expect(panel(page).getByRole("button", { name: "Close Ask Warden" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Pin" })).toHaveCount(0);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(panel(page).getByRole("button", { name: "Pin" })).toBeVisible();
});

test("pinned at 1400px, the page ends at or left of the panel's left edge", async ({ page }) => {
  await pinnedAt1400(page);
  const main = (await page.locator("main.page").boundingBox())!;
  const box = (await panel(page).boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(box.x);
  expect(box.x + box.width).toBe(await viewportRight(page));
});

// The keys' steps and limits, and aria-valuenow, are AskWardenPanel.test.tsx's; here, that a real key moves the panel.
test("the divider takes focus; → narrows and ← widens the panel by 24px", async ({ page }) => {
  await pinnedAt1400(page);
  await divider(page).focus();
  await expect(divider(page)).toBeFocused();

  await page.keyboard.press("ArrowRight");
  expect(await panelWidth(page)).toBe(376);
  await page.keyboard.press("ArrowLeft");
  expect(await panelWidth(page)).toBe(400);
});

test("dragging the divider past either end stops at 680 or 320px, and stores the width when the drag ends", async ({
  page,
}) => {
  await pinnedAt1400(page);
  const right = await viewportRight(page);
  const grip = (await divider(page).boundingBox())!;
  const y = grip.y + grip.height / 2;
  const storedWidth = () =>
    page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem("warden.askWardenPanel") ?? "{}") as { width?: number })
          .width,
    );

  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await expect(divider(page)).toHaveAttribute("data-dragging", "true");
  await page.mouse.move(10, y, { steps: 5 });
  expect(await panelWidth(page)).toBe(680);
  await page.mouse.move(right - 10, y, { steps: 5 });
  expect(await panelWidth(page)).toBe(320);
  expect(await storedWidth()).toBe(400);
  await page.mouse.up();
  await expect(divider(page)).not.toHaveAttribute("data-dragging");
  expect(await storedWidth()).toBe(320);
});

test("a person's choice survives a reload and wins over the width default: pinned at a width, at 1400px", async ({
  page,
}) => {
  await pinnedAt1400(page);
  await divider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await page.reload();
  await expect(panel(page)).toHaveAttribute("data-shown", "pinned");
  expect(await panelWidth(page)).toBe(424);
});

test("story 9: a Member at 1700px lands on Findings with the panel pinned, and the first card fills the detail card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/findings$/);
  await expect(panel(page)).toHaveAttribute("data-shown", "pinned");
  expect(await panelWidth(page)).toBe(400);

  const first = page.locator(".finding-card").first();
  const title = await first.locator(".card-title").textContent();
  await first.click();

  const card = panel(page).locator(".detail-card");
  await expect(card.getByRole("heading", { level: 3 })).toHaveText(title!);
  const id = new URL(page.url()).searchParams.get("finding")!;
  await expect(panel(page).locator(".context-line")).toHaveText(
    `Talking about: ${id.slice(0, 8)} · view: Findings, Open`,
  );
  await expect(panel(page)).toHaveAttribute("data-shown", "pinned");
});

for (const [width, shown] of [
  [1024, "floating"],
  [390, "full-screen"],
] as const) {
  test(`story 9: a link to a Finding at ${width}px opens the panel ${shown} with that Finding's detail card`, async ({
    page,
  }) => {
    await openAt(page, width);
    const first = page.locator(".finding-card").first();
    const title = await first.locator(".card-title").textContent();
    const id = await first.getAttribute("data-finding");

    await page.goto(`/findings?finding=${id}`);

    await expect(panel(page)).toHaveAttribute("data-shown", shown);
    await expect(panel(page).locator(".detail-card").getByRole("heading", { level: 3 })).toHaveText(
      title!,
    );
  });
}

test("story 3: after Grace proposes on a seeded Finding, she sees the Proposal in its detail card", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const token = await sessionToken(await signingKey(), origin, GRACE, ACME, "member");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const findings = (await (await fetch(`${origin}/api/findings`, { headers })).json()) as {
    findings: { id: string; title: string }[];
  };
  const target = findings.findings.find((f) => f.title.startsWith("minimist 1.2.5"))!;
  const reason = `Only a build tool, never shipped (${test.info().project.name})`;
  const proposed = await fetch(`${origin}/api/findings/${target.id}/proposals`, {
    method: "POST",
    headers,
    body: JSON.stringify({ decision: "mark_false_positive", reason }),
  });
  expect(proposed.status).toBe(201);

  await page.setViewportSize({ width: 1700, height: 900 });
  await page.goto(`/findings?finding=${target.id}`);

  const card = panel(page).locator(".detail-card");
  await expect(card.getByRole("heading", { level: 3 })).toHaveText(target.title);
  const mine = card.getByRole("listitem").filter({ hasText: reason });
  await expect(mine).toContainText("Mark False positive");
  // Her own Proposal: "Asked by you" (#59).
  await expect(mine).toContainText("Asked by you");
});

test.describe("motion", () => {
  const motion = (page: Page, selector: string) =>
    page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el);
      return { name: style.animationName, duration: style.animationDuration };
    });

  test("the floating panel slides in over 150ms, and the detail card fades in over 120ms", async ({
    page,
  }) => {
    await openAt(page, 1024);
    await page.locator(".finding-card").first().click();
    expect(await motion(page, ".ask-warden.floating")).toEqual({
      name: "panel-slide-in",
      duration: "0.15s",
    });
    expect(await motion(page, ".detail-card")).toEqual({
      name: "detail-card-in",
      duration: "0.12s",
    });
  });

  test("with reduced motion, both appear without moving", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openAt(page, 1024);
    await page.locator(".finding-card").first().click();
    expect((await motion(page, ".ask-warden.floating")).name).toBe("none");
    expect((await motion(page, ".detail-card")).name).toBe("none");
  });
});
