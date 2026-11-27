// Story 9, end to end: a Member opening Warden lands on the Findings page with their Team's seeded Findings, the
// top 5 in order, filters that change the table and step back with Back, and a selection a reload keeps.
import type { Page } from "@playwright/test";
import { expect, GRACE, test } from "./session.ts";

const TOP_FIVE = [
  "A live Stripe secret key is committed",
  "lodash 4.17.20 has a known vulnerability",
  "minimist 1.2.5 has a known vulnerability",
  "The agent can read .env files",
  "The agent printed a secret to the terminal",
];

const bodyRows = (page: Page) =>
  page.getByRole("table", { name: "All Findings" }).locator("tbody tr");
const tab = (page: Page, group: string, name: string) =>
  page.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

test("a Member lands on Findings, filters the table, steps Back, and keeps a selection over a reload", async ({
  page,
  signIn,
}) => {
  await signIn(GRACE);
  await page.goto("/");

  await expect(page).toHaveURL(/\/findings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("7 open Findings, 2 Critical");
  await expect(page.locator(".finding-card .card-title")).toHaveText(TOP_FIVE);
  await expect(bodyRows(page)).toHaveCount(7);

  // Two filter changes, then Back: the first change's view, table and URL.
  await tab(page, "Status", "Fixed").click();
  await expect(bodyRows(page)).toHaveCount(2);
  await tab(page, "Module", "Patch").click();
  await expect(page).toHaveURL(/\/findings\?status=fixed&module=patch$/);
  await expect(bodyRows(page)).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/findings\?status=fixed$/);
  await expect(bodyRows(page)).toHaveCount(2);

  // A selection goes into the URL and survives a reload.
  const card = page.locator(".finding-card", { hasText: "lodash 4.17.20" });
  await card.click();
  await expect(page).toHaveURL(/\/findings\?status=fixed&finding=[0-9a-f-]{36}$/);
  const selected = page.url();
  await page.reload();
  expect(page.url()).toBe(selected);
  await expect(card).toHaveAttribute("aria-current", "true");
});

// #452: a Proposal answered 404 (the Finding has left the Team) puts the gone notice on the page; a panel over the
// page (full screen on a phone, floating) closes so the notice can be read, and one pinned beside it stays. The 404
// and the list without the Finding are faked here, so the seeded data isn't changed; which states close is
// panel.test.ts's, and the page calling the panel is dashboard/test/Findings.test.tsx's.
for (const [width, shown, after] of [
  [390, "full-screen", null],
  [1024, "floating", null],
  [1600, "pinned", "pinned"],
] as const) {
  const what = after === null ? `closes the ${shown} panel` : "leaves the pinned panel";
  test(`at ${width}px, the gone notice ${what}, and nothing covers the notice`, async ({
    page,
    signIn,
  }) => {
    await signIn(GRACE);
    await page.setViewportSize({ width, height: 900 });
    let gone: string | null = null;
    await page.route("**/api/findings/*/proposals", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      gone = new URL(route.request().url()).pathname.split("/")[3]!;
      await route.fulfill({ status: 404, json: { error: "Finding not found" } });
    });
    await page.route("**/api/findings", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { findings: { id: string }[] };
      await route.fulfill({
        response,
        json: { ...body, findings: body.findings.filter((f) => f.id !== gone) },
      });
    });
    await page.goto("/findings");
    await expect(bodyRows(page)).toHaveCount(7);

    const panel = page.getByRole("complementary", { name: "Ask Warden" });
    await page.locator(".finding-card", { hasText: "lodash 4.17.20" }).click();
    if (shown === "pinned") await panel.getByRole("button", { name: "Pin" }).click();
    await expect(panel).toHaveAttribute("data-shown", shown);
    await panel.getByRole("button", { name: "Propose False positive" }).click();
    const propose = panel.getByRole("form", { name: "Propose False positive" });
    await propose.getByRole("textbox", { name: "Reason" }).fill("Only a build tool");
    await propose.getByRole("button", { name: "Propose" }).click();

    const notice = page.locator("main").getByRole("alert");
    await expect(notice).toHaveText("This Finding is no longer in your Team.");
    await expect(bodyRows(page)).toHaveCount(6);
    if (after === null) await expect(panel).toHaveCount(0);
    else await expect(panel).toHaveAttribute("data-shown", after);
    // Nothing sits over the notice: the element at its centre is inside it.
    await notice.scrollIntoViewIfNeeded();
    const box = (await notice.boundingBox())!;
    expect(
      await notice.evaluate(
        (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
        {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        },
      ),
    ).toBe(true);
  });
}
