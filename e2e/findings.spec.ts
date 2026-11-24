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
