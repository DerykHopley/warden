// Story 3: a Member reaches every page of their Team's Warden from the header, and each shows that Team's data, none
// of Bluebird's.
import { expect, GRACE, test } from "./session.ts";

test("a Member reaches Findings and People from the header, each with their Team's data", async ({
  page,
  signIn,
}) => {
  await signIn(GRACE);
  await page.goto("/");
  const links = page.getByRole("navigation", { name: "Pages" }).getByRole("link");
  await expect(links).toHaveText(["Findings", "People"]);
  await expect(page.getByRole("banner")).toContainText("Acme");
  await expect(page.getByRole("banner")).toContainText("Member");

  await links.filter({ hasText: "People" }).click();
  await expect(page).toHaveURL(/\/people$/);
  const people = page.getByRole("table");
  await expect(people.locator("tbody tr")).toHaveCount(2);
  await expect(people.locator("tr", { hasText: "Ada Lovelace" })).toContainText("Admin");
  await expect(people.locator("tr", { hasText: "Grace Hopper" })).toContainText("Member");
  await expect(people).not.toContainText("Linus");
  // A Member sees Roles as words: only an Admin has pickers.
  await expect(page.getByRole("combobox")).toHaveCount(0);

  await links.filter({ hasText: "Findings" }).click();
  await expect(page).toHaveURL(/\/findings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("7 open Findings, 2 Critical");
  await expect(page.getByRole("link", { name: "Findings" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
