// Spec #225's story 10 on Setup: an Admin sets the Team's own Judge model and puts it back on OpenRouter (#464). The
// round trip runs on Acme against the real server, with its localhost setting on (`global-setup.ts`); no session of
// Acme's is judged (only Hazel's are, in agent-session.spec.ts), so the setting changes nothing else. The layout
// check fakes a set model in the browser, so Use OpenRouter shows at each width. The section's words, refusals and
// busy states are JudgeModelSection.test.tsx's.
import type { Page } from "@playwright/test";
import { expectNoSidewaysScroll, expectRings, expectTargets } from "./a11y.ts";
import { ACME, ADA, expect, sendAsAdmin, test } from "./session.ts";

const WIDTHS = [390, 1024, 1600] as const;
const DEFAULT = "The Judge calls OpenRouter (the default).";
const URL_SET = "http://localhost:11434/v1";
const MODEL_SET = "qwen3.8:27b";

const judgeSection = (page: Page) => page.getByRole("region", { name: "Judge's model" });

// Acme starts on OpenRouter, so a run that failed before Use OpenRouter leaves nothing for the next one to trip on.
test.beforeEach(() => sendAsAdmin(ACME, "PUT", "/api/judge/model", { local_model: null }));

test("story 10: an Admin saves the Team's own model, which a reload keeps, then Use OpenRouter puts back the default", async ({
  page,
  signIn,
}) => {
  await signIn(ADA);
  await page.goto("/setup");
  // Its place after "Agent hook" is setup.spec.ts's heading list.
  const judge = judgeSection(page);
  await expect(judge.getByText(DEFAULT)).toBeVisible();

  await judge.getByRole("textbox", { name: "URL" }).fill(URL_SET);
  await judge.getByRole("textbox", { name: "Model name" }).fill(MODEL_SET);
  await judge.getByRole("button", { name: "Save" }).click();
  await expect(judge.getByText(URL_SET, { exact: true })).toBeVisible();
  await expect(judge.getByText(MODEL_SET, { exact: true })).toBeVisible();

  await page.reload();
  await expect(judge.getByText(URL_SET, { exact: true })).toBeVisible();
  await expect(judge.getByText(MODEL_SET, { exact: true })).toBeVisible();

  await judge.getByRole("button", { name: "Use OpenRouter" }).click();
  await expect(judge.getByText(DEFAULT)).toBeVisible();
  await expect(judge.getByText(URL_SET, { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(judge.getByText(DEFAULT)).toBeVisible();
  await expect(judge.getByText(MODEL_SET, { exact: true })).toHaveCount(0);
});

for (const width of WIDTHS) {
  test(`the Judge's model section at ${width}px: nothing scrolls sideways, and its fields and buttons are 44px targets with a focus ring`, async ({
    page,
    signIn,
  }) => {
    await signIn(ADA);
    // A long URL, as a hosted endpoint's can be, so its wrapping is measured too.
    await page.route("**/api/judge/model", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              local_model: {
                url: `https://models.example.com/${"v1/".repeat(40)}openai`,
                model: MODEL_SET,
                set_at: "2026-11-27T09:14:00.000Z",
              },
            },
          })
        : route.abort(),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/setup");
    const judge = judgeSection(page);
    await expect(judge.getByRole("button", { name: "Use OpenRouter" })).toBeVisible();

    await expectNoSidewaysScroll(page);
    const targets = await judge.locator("button, input").all();
    expect(targets).toHaveLength(4);
    await expectTargets(targets);
    await expectRings(page, targets);
  });
}
