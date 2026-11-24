// Story 9, end to end: a Member opening Warden lands on the Findings page with their Team's seeded Findings, the
// top 5 in order, filters that change the table and step back with Back, and a selection a reload keeps.
import { expect, GRACE, test } from "./session.ts";

const TOP_FIVE = [
  "A live Stripe secret key is committed",
  "lodash 4.17.20 has a known vulnerability",
  "minimist 1.2.5 has a known vulnerability",
  "The agent can read .env files",
  "The agent printed a secret to the terminal",
];

test.beforeEach(async ({ signIn }) => {
  await signIn(GRACE);
});

const table = (page: import("@playwright/test").Page) =>
  page.getByRole("table", { name: "All Findings" });
const bodyRows = (page: import("@playwright/test").Page) => table(page).locator("tbody tr");

test("a Member opening / lands on Findings: the summary, the top 5 in order, and a filter that changes the table", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/findings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("7 open Findings, 2 Critical");
  await expect(page.locator(".finding-card .card-title")).toHaveText(TOP_FIVE);
  await expect(bodyRows(page)).toHaveCount(7);

  await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: "High" }).click();

  await expect(page).toHaveURL(/\/findings\?severity=high$/);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(page.locator(".finding-card .card-title")).toHaveText(TOP_FIVE);
});

test("Back after two filter changes shows the first view's table and URL", async ({ page }) => {
  await page.goto("/findings");
  await expect(bodyRows(page)).toHaveCount(7);

  await page.getByRole("group", { name: "Status" }).getByRole("button", { name: "Fixed" }).click();
  await expect(bodyRows(page)).toHaveCount(2);
  await page.getByRole("group", { name: "Module" }).getByRole("button", { name: "Patch" }).click();
  await expect(bodyRows(page)).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/findings\?status=fixed$/);
  await expect(bodyRows(page)).toHaveCount(2);

  await page.goBack();
  await expect(page).toHaveURL(/\/findings$/);
  await expect(bodyRows(page)).toHaveCount(7);

  await page.goForward();
  await expect(page).toHaveURL(/\/findings\?status=fixed$/);
  await expect(bodyRows(page)).toHaveCount(2);
});

test("a selected Finding stays selected after a reload", async ({ page }) => {
  await page.goto("/findings");
  const card = page.locator(".finding-card", { hasText: "lodash 4.17.20" });
  await card.click();
  await expect(page).toHaveURL(/\/findings\?finding=[0-9a-f-]{36}$/);
  const url = page.url();

  await page.reload();

  expect(page.url()).toBe(url);
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(table(page).locator("tr", { hasText: "lodash 4.17.20" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
