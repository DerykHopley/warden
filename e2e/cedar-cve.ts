// An open CVE Finding in Cedar, on its own LangChain Product, and its detail card opened from the Findings page: shared
// by the specs that check the card's Patch section (patch-card, layout, keyboard).
import type { Page } from "@playwright/test";
import { FindingsBody, PatchAssessment, type Finding } from "@warden/contracts";
import {
  CEDAR,
  ensureProduct,
  expect,
  HEDY,
  LANGCHAIN_SERVICE,
  sessionToken,
  signingKey,
} from "./session.ts";

/** GETs `path` as Hedy, Cedar's Admin, as the page does for her; its body. */
export async function asHedy(path: string): Promise<unknown> {
  const origin = process.env.E2E_BASE_URL;
  if (!origin) throw new Error("E2E_BASE_URL is unset: run the browser tests with `pnpm e2e`");
  const token = await sessionToken(await signingKey(), origin, HEDY, CEDAR, "admin");
  const res = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Finding `id`'s assessment, as the route answers Hedy. */
export async function assessmentOf(id: string): Promise<PatchAssessment> {
  return PatchAssessment.parse(
    await asHedy(`/api/patch/findings/${encodeURIComponent(id)}/assessment`),
  );
}

/**
 * An Open CVE Finding on Cedar's LangChain service (saved first if it isn't there), read through the API: the first
 * whose assessment `wanted` takes, when given.
 */
export async function cedarCveFinding(
  wanted?: (assessment: PatchAssessment) => boolean,
): Promise<Finding> {
  const productId = await ensureProduct(CEDAR, LANGCHAIN_SERVICE);
  const { findings } = FindingsBody.parse(await asHedy("/api/findings"));
  const open = findings.filter(
    (f) =>
      f.module === "patch" &&
      f.status === "open" &&
      f.asset.kind === "product" &&
      f.asset.ref === productId &&
      /^CVE-\d{4}-\d+/.test(f.title),
  );
  for (const finding of open) {
    if (wanted === undefined || wanted(await assessmentOf(finding.id))) return finding;
  }
  throw new Error("Cedar's LangChain service has no open CVE Finding the test can use");
}

/**
 * Opens `finding`'s detail card from the Findings page (already open, signed in to Cedar) and waits for its Patch
 * section's assessment. Another Cedar Product can have a Finding with the same CVE title: the row is the one on
 * `finding`'s Product.
 */
export async function openCveCard(page: Page, finding: Finding) {
  await page
    .getByRole("table", { name: "All Findings" })
    .getByRole("row")
    .filter({ has: page.locator(".asset-ref", { hasText: finding.asset.ref }) })
    .filter({ has: page.locator(".finding-title", { hasText: finding.title }) })
    .locator(".finding-link")
    .click();
  const patch = page.locator(".detail-card").getByRole("region", { name: "Patch" });
  await expect(patch.locator("dt", { hasText: "Who acts" })).toBeVisible();
  return patch;
}
