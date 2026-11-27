// The Guard spec's story 7 on Setup: an Admin issues and rotates the hook token, and copies the managed-settings
// block. Issuing runs on Acme against the real server (no other test issues Acme a token); the rotation runs on Ginkgo,
// whose two tokens the global setup issued 50 and 25 hours before the run, and the hook endpoint is called as a
// laptop's managed hook would call it. The layout check fakes the hook's answers in the browser, so its confirm, its
// token and its block are measured at each width without changing Acme's token. The section's words, states and
// failures are Setup.test.tsx's.
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { HOOK_TOKEN_PLACEHOLDER, PrivacyTier } from "@warden/contracts";
import { HOOK_EVENTS_PATH } from "../server/src/modules/guard/managed-settings.ts";
import { expectNoSidewaysScroll, expectRings, expectTargets } from "./a11y.ts";
import { ADA, BARBARA, expect, GINKGO, seededHookTokens, test } from "./session.ts";

const WIDTHS = [390, 1024, 1600] as const;

const hookSection = (page: Page) => page.getByRole("region", { name: "Agent hook" });

/** Sends one `SessionStart` with `token`, as a laptop's managed hook would: the status the endpoint answers. */
async function sessionStart(request: APIRequestContext, baseURL: string, token: string) {
  const res = await request.post(new URL(HOOK_EVENTS_PATH, baseURL).toString(), {
    headers: { Authorization: `Bearer ${token}`, "X-Warden-Developer": "barbara" },
    data: { session_id: randomUUID(), hook_event_name: "SessionStart" },
  });
  return res.status();
}

test("an Admin issues a hook token, shown once: after a reload it's gone and the block holds the placeholder", async ({
  page,
  signIn,
}) => {
  await signIn(ADA);
  await page.goto("/setup");
  const hook = hookSection(page);
  await expect(hook.getByText("No hook token yet.")).toBeVisible();
  await hook.getByRole("button", { name: "Issue a hook token" }).click();

  const shown = hook.locator("code.hook-token-value");
  await expect(shown).toBeVisible();
  const token = (await shown.textContent()) ?? "";
  expect(token).toMatch(/^org_e2e_acme\.[A-Za-z0-9_-]{43}$/);
  const block = hook.locator("pre.hook-block");
  await expect(block).toContainText(token);
  await expect(block).not.toContainText(HOOK_TOKEN_PLACEHOLDER);

  await page.reload();
  await expect(block).toContainText(HOOK_TOKEN_PLACEHOLDER);
  await expect(block).not.toContainText(token);
  await expect(hook.locator("code.hook-token-value")).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
});

test("story 7: a rotation keeps the token before it working for 24 hours, and an older one stays refused", async ({
  page,
  signIn,
  request,
  baseURL,
}) => {
  const { issued50hAgo, issued25hAgo } = seededHookTokens();
  // 24 hours after the 25-hour-old token was issued, the 50-hour-old one stopped working.
  expect(await sessionStart(request, baseURL!, issued50hAgo)).toBe(401);

  await signIn(BARBARA, GINKGO);
  await page.goto("/setup");
  const hook = hookSection(page);
  await expect(hook.getByText(/^Hook token issued /)).toBeVisible();
  await expect(hook.getByText(/^The token before it works until /)).toHaveCount(0);
  // No token before the current one still works, so the rotation asks nothing first.
  await hook.getByRole("button", { name: "Rotate the hook token" }).click();
  const shown = hook.locator("code.hook-token-value");
  await expect(shown).toBeVisible();
  const rotated = (await shown.textContent()) ?? "";
  expect(rotated).toMatch(/^org_e2e_ginkgo\./);

  expect(await sessionStart(request, baseURL!, issued25hAgo)).toBe(204);
  expect(await sessionStart(request, baseURL!, rotated)).toBe(204);
});

/** The settings `GET /api/hook` answers, with a current token and one before it still working. */
const ISSUED_AT = "2026-11-26T09:14:00.000Z";
const PREVIOUS_UNTIL = "2026-11-27T09:14:00.000Z";

for (const width of WIDTHS) {
  test(`the Agent hook section at ${width}px: nothing scrolls sideways, and its controls are 44px targets with a focus ring`, async ({
    page,
    signIn,
  }) => {
    await signIn(ADA);
    // Acme's real block, with a token before the current one still working, so the confirm shows.
    let block: Record<string, unknown> = {};
    await page.route("**/api/hook", async (route) => {
      const real = await route.fetch();
      block = ((await real.json()) as { managed_settings: Record<string, unknown> })
        .managed_settings;
      return route.fulfill({
        json: {
          token: { issued_at: ISSUED_AT },
          previous_valid_until: PREVIOUS_UNTIL,
          privacy_tier: "details",
          managed_settings: block,
        },
      });
    });
    await page.route("**/api/hook/token", (route) =>
      route.fulfill({
        status: 201,
        json: {
          token: `org_e2e_acme.${"A".repeat(43)}`,
          issued_at: "2026-11-26T10:00:00.000Z",
          previous_valid_until: "2026-11-27T10:00:00.000Z",
          managed_settings: block,
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/setup");
    const hook = hookSection(page);
    await expect(hook.getByText(/^The token before it works until /)).toBeVisible();

    /** Measures `targets`, or every control in the section when none are named (none is disabled then). */
    const measure = async (named?: Locator[]) => {
      await expectNoSidewaysScroll(page);
      const targets = named ?? (await hook.locator("button, select").all());
      expect(targets.length).toBeGreaterThan(0);
      await expectTargets(targets);
      await expectRings(page, targets);
    };
    await measure();

    // While the confirm is open, Rotate is disabled: its two buttons are measured.
    await hook.getByRole("button", { name: "Rotate the hook token" }).click();
    await expect(hook.getByRole("group")).toBeVisible();
    await measure([
      hook.getByRole("button", { name: "Rotate again" }),
      hook.getByRole("button", { name: "Cancel" }),
    ]);

    await hook.getByRole("button", { name: "Rotate again" }).click();
    await expect(hook.locator("code.hook-token-value")).toBeVisible();
    await measure();
  });
}

/**
 * How much of `select`'s selected option the closed picker cuts off, in pixels (0: none). A select's scrollWidth
 * doesn't grow with its text, so the browser measures it: a copy holding only that option, free of every width rule,
 * sits beside it, and is as wide as the select must be to show the option whole.
 */
const clippedBy = (select: Locator) =>
  select.evaluate((picker: HTMLSelectElement) => {
    const copy = picker.cloneNode(false) as HTMLSelectElement;
    copy.removeAttribute("id");
    copy.append(picker.selectedOptions[0]!.cloneNode(true));
    copy.style.cssText = "position: absolute; visibility: hidden; width: auto; max-width: none;";
    picker.after(copy);
    const needs = copy.getBoundingClientRect().width;
    copy.remove();
    return Math.max(0, Math.ceil(needs - picker.getBoundingClientRect().width));
  });

// A screen reader hears the three tier lines as the picker's description, computed as a browser does (#436).
test("the Privacy tier picker's accessible description is what each tier sends", async ({
  page,
  signIn,
}) => {
  await signIn(ADA);
  await page.goto("/setup");
  await expect(
    hookSection(page).getByRole("combobox", { name: "Privacy tier" }),
  ).toHaveAccessibleDescription(
    "Metadata: tool names and outcomes Details: adds commands, file paths and URLs Content: adds tool output and prompts",
  );
});

// A closed select shows its selected option on one line, which can't wrap: at 390px each tier's option fits inside the
// picker (#422).
for (const tier of PrivacyTier.options) {
  test(`at 390px with the ${tier} tier picked, the closed Privacy tier picker shows its whole option`, async ({
    page,
    signIn,
  }) => {
    await signIn(ADA);
    await page.route("**/api/hook", async (route) => {
      const real = (await (await route.fetch()).json()) as Record<string, unknown>;
      return route.fulfill({ json: { ...real, privacy_tier: tier } });
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/setup");
    const picker = hookSection(page).getByRole("combobox", { name: "Privacy tier" });
    await expect(picker).toHaveValue(tier);
    await expectNoSidewaysScroll(page);
    expect(await clippedBy(picker)).toBe(0);
  });
}
