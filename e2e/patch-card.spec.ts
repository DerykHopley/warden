// Spec #101, stories 5 and 6: a Patch Finding's detail card says whether the Product's version is affected and why,
// what fixes it, who acts, and how urgent it is and when it's due, as the assessment route answers it. In Cedar, on its
// own LangChain Product; and in Acme, a demo Finding whose CVE the snapshot doesn't hold says so. A failed
// assessment's line sits as the failed Proposals' line does (a 503 from each, faked in the browser).
import type { Locator, Route } from "@playwright/test";
import { assessmentOf, cedarCveFinding, openCveCard, selectCveRow } from "./cedar-cve.ts";
import { ACME, CEDAR, expect, GRACE, HEDY, test } from "./session.ts";

test("Hedy opens a CVE Finding from Findings, and its Patch section says what the assessment route answers", async ({
  page,
  signIn,
}) => {
  const finding = await cedarCveFinding();
  const assessment = await assessmentOf(finding.id);
  await signIn(HEDY, CEDAR);
  await page.goto("/findings");
  const patch = await openCveCard(page, finding);
  await expect(patch.getByRole("heading", { level: 4, name: "Patch" })).toBeVisible();
  const row = (term: string) => patch.locator("dt", { hasText: term }).locator("+ dd");

  const verdict = { affected: "Affected", not_affected: "Not affected", unknown: "Can't tell" };
  await expect(row("Your version").locator("strong")).toHaveText(verdict[assessment.verdict]);
  await expect(row("Your version")).toContainText(assessment.reason);

  const fixedIn =
    assessment.fixes.length > 1
      ? assessment.fixes.map((fix) => `${fix.package}: ${fix.fixed_version ?? "no fix listed yet"}`)
      : [assessment.fixed_version ?? "No fix listed yet."];
  await expect(row("Fixed in")).toHaveText(fixedIn.join(""));

  const whoActs = {
    you: "You",
    upstream: "Upstream: the package that brings it in",
    vendor: "The vendor",
  };
  await expect(row("Who acts")).toHaveText(
    assessment.who_acts === null
      ? "No one now: the Product no longer uses this framework."
      : whoActs[assessment.who_acts],
  );

  const level = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  await expect(row("Priority").locator("strong")).toHaveText(level[assessment.priority.level]);
  // The due day as the browser says a day, in its own locale and time zone.
  const dueDay = await page.evaluate(
    (day) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }),
    assessment.priority.due_date,
  );
  await expect(row("Priority").locator(".patch-due")).toHaveText(
    `Due ${dueDay} (${assessment.priority.due_from})`,
  );

  await expect(row("Links").getByRole("link", { name: "NVD" })).toHaveAttribute(
    "href",
    assessment.links.nvd,
  );
});

test("Grace opens the @aws-sdk demo Finding in Acme, and its Patch section says the snapshot doesn't hold its CVE", async ({
  page,
  signIn,
}) => {
  await signIn(GRACE, ACME);
  await page.goto("/findings");
  await page.locator(".finding-link", { hasText: "@aws-sdk" }).click();
  const patch = page.locator(".detail-card").getByRole("region", { name: "Patch" });
  await expect(patch).toContainText(
    "The CVE snapshot doesn't hold GHSA-demo-0001, so its Finding can't be assessed",
  );
  await expect(patch.getByRole("button")).toHaveCount(0);
});

test("when the assessment and the Proposals both fail, the Patch section's failed line sits as the Proposals' does", async ({
  page,
  signIn,
}) => {
  const finding = await cedarCveFinding();
  await signIn(HEDY, CEDAR);
  const down = (route: Route) => route.fulfill({ status: 503, json: { error: "Down" } });
  await page.route("**/api/patch/findings/*/assessment", down);
  await page.route("**/api/proposals", down);
  await page.goto("/findings");
  const patch = await selectCveRow(page, finding);

  const patchFailed = patch.locator(".patch-failed");
  const proposalsFailed = page.locator(".detail-card .proposals-failed");
  await expect(patchFailed).toContainText("Couldn't load the CVE assessment.");
  await expect(proposalsFailed).toContainText("Couldn't load Proposals");
  const margins = (line: Locator) =>
    line.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft];
    });
  expect(await margins(patchFailed)).toEqual(await margins(proposalsFailed));
});
