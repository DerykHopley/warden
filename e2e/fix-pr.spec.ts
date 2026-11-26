// Story 6 (#224): a Member opens a Fix PR from an Open Guard Finding's detail card, through the real server's route
// and the write app's calls, which reach the GitHub fake (`fake-github.ts`) and never GitHub. In Dahlia, whose one
// Repo Asset holds a write grant and an Open `guard/agent-can-read-env` Finding (the global setup's
// `seedDahliaFixPr`). The fake logs each call it answers (`E2E_FAKE_GITHUB_LOG`), which these tests read.
//
// Serial, in one worker: story 6's test opens the file's one Fix PR first, and the look checks after it read that PR,
// never opening a second.
import { readFileSync } from "node:fs";
import { FindingsBody, type Finding } from "@warden/contracts";
import type { Locator, Page } from "@playwright/test";
import { expectRings, expectTargets } from "./a11y.ts";
import { createFakeGitHub, type Logged } from "./fake-github.ts";
import {
  ANNIE,
  asAdmin,
  DAHLIA,
  DAHLIA_REPO,
  expect,
  signInEachTest,
  SIGNS_IN_ITSELF,
  test,
} from "./session.ts";

test.describe.configure({ mode: "serial" });

/** Every call the server's GitHub fake has logged so far, in the order it answered them. */
function logged(): Logged[] {
  const log = process.env.E2E_FAKE_GITHUB_LOG;
  if (!log) throw new Error("E2E_FAKE_GITHUB_LOG is unset: run the browser tests with `pnpm e2e`");
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Logged);
}

let read: Promise<Finding> | undefined;
/** Dahlia's Open `guard/agent-can-read-env` Finding, read through the API as its Admin once a worker. */
const dahliaFinding = () => (read ??= readDahliaFinding());

async function readDahliaFinding(): Promise<Finding> {
  const { origin, headers } = await asAdmin(DAHLIA);
  const res = await fetch(`${origin}/api/findings`, { headers });
  if (!res.ok) throw new Error(`listing Dahlia's Findings: ${res.status} ${await res.text()}`);
  const finding = FindingsBody.parse(await res.json()).findings.find(
    (f) => f.rule_id === "guard/agent-can-read-env",
  );
  if (finding === undefined) throw new Error("Dahlia has no agent-can-read-env Finding");
  return finding;
}

/** The fake's paths on Dahlia's repo, as the write app calls them. */
const repoPath = (path: string) => `/repos/${new URL(DAHLIA_REPO.ref).pathname.slice(1)}/${path}`;

const isTokenRequest = (call: Logged) =>
  call.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(call.path);
const isRefCreate = (call: Logged) => call.method === "POST" && call.path === repoPath("git/refs");
const isContentsWrite = (call: Logged) =>
  call.method === "PUT" && call.path.startsWith(repoPath("contents/"));
const isPullCreate = (call: Logged) => call.method === "POST" && call.path === repoPath("pulls");

/** Opens Dahlia's Finding's detail card from its Start here card on Findings, and answers its Fix PR section. */
async function openFixPrSection(page: Page): Promise<Locator> {
  const { id } = await dahliaFinding();
  await page.goto("/findings");
  await page.locator(`.finding-card[data-finding="${id}"]`).click();
  return page.locator(".detail-card").getByRole("region", { name: "Fix PR" });
}

// Annie is Dahlia's Member.
signInEachTest(ANNIE, DAHLIA);

// No page and no server: the fake's own handler, with its own log, and no one signed in (`SIGNS_IN_ITSELF` keeps
// `signInEachTest` from opening a page). Playwright reads a test's fixtures from its first parameter's pattern, and
// this one needs none.
test(
  "the fake answers a GitHub path it doesn't fake with 404, logged without its Authorization",
  SIGNS_IN_ITSELF,
  // eslint-disable-next-line no-empty-pattern
  async ({}, testInfo) => {
    const log = testInfo.outputPath("fake-github.jsonl");
    const handle = createFakeGitHub({ log });
    const answer = await handle(
      new Request("https://api.github.com/orgs/dahlia/repos?per_page=1", {
        headers: { Authorization: "Bearer ghs_never_logged" },
      }),
    );
    expect(answer.status).toBe(404);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { method: "GET", path: "/orgs/dahlia/repos?per_page=1", body: null },
    ]);
    expect(lines.join("\n")).not.toContain("ghs_never_logged");
  },
);

test("a Member opens a Fix PR from the Finding's detail card, and a second click answers the same PR (story 6)", async ({
  page,
}) => {
  const branch = `warden/fix-${(await dahliaFinding()).id}`;
  const before = logged().length;
  const fixPr = await openFixPrSection(page);
  await fixPr.getByRole("button", { name: "Open a Fix PR" }).click();

  const line = fixPr.getByRole("status");
  await expect(line).toHaveText(/^Fix PR #\d+ opened\.$/);
  const number = Number((await line.textContent())!.match(/#(\d+)/)![1]);
  const url = `${DAHLIA_REPO.ref}/pull/${number}`;
  await expect(fixPr.getByRole("link", { name: `Fix PR #${number}` })).toHaveAttribute("href", url);

  // The token for Dahlia's repo alone, then the branch, the commit on it, and the PR from it into main, in that order.
  const calls = logged().slice(before);
  const token = calls.findIndex(isTokenRequest);
  expect(calls[token]?.body).toEqual({ repository_ids: [DAHLIA_REPO.githubId] });
  const writes = calls.filter(
    (call) => isRefCreate(call) || isContentsWrite(call) || isPullCreate(call),
  );
  expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `POST ${repoPath("git/refs")}`,
    `PUT ${repoPath("contents/.claude/settings.json")}`,
    `POST ${repoPath("pulls")}`,
  ]);
  expect(calls.indexOf(writes[0]!)).toBeGreaterThan(token);
  expect(writes[0]!.body).toMatchObject({ ref: `refs/heads/${branch}` });
  expect(writes[1]!.body).toMatchObject({ branch });
  expect(writes[2]!.body).toMatchObject({ head: branch, base: "main" });

  // A second click answers the PR already open, and writes nothing more.
  const beforeSecond = logged().length;
  await fixPr.getByRole("button", { name: "Open a Fix PR" }).click();
  await expect(line).toHaveText(`Fix PR #${number} is still open.`);
  await expect(fixPr.getByRole("link", { name: `Fix PR #${number}` })).toHaveAttribute("href", url);
  const again = logged().slice(beforeSecond);
  expect(again.filter(isTokenRequest)).toHaveLength(1);
  expect(
    again.filter((call) => isRefCreate(call) || isContentsWrite(call) || isPullCreate(call)),
  ).toEqual([]);

  // After a reload, the card still holds the PR's link, opened by the person reading it.
  await page.reload();
  const reloaded = await openFixPrSection(page);
  await expect(reloaded.getByRole("link", { name: `Fix PR #${number}` })).toHaveAttribute(
    "href",
    url,
  );
  await expect(reloaded.locator(".fix-pr-opened")).toContainText("Opened by you");
});

const WIDTHS = [390, 1024, 1600] as const;
const SCHEMES = ["light", "dark"] as const;

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`at ${width}px in ${scheme}, the Fix PR section scrolls nothing sideways, and its link wears --accent`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      const fixPr = await openFixPrSection(page);
      const link = fixPr.getByRole("link", { name: /^Fix PR #\d+$/ });
      await expect(link).toBeVisible();

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // The root's --accent as the browser computes a colour, read from a probe that wears it.
      const accent = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.documentElement.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      });
      expect(await link.evaluate((el) => getComputedStyle(el).color)).toBe(accent);
    });
  }

  test(`at ${width}px, the Fix PR link and its button are 44px targets with a focus ring`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixPr = await openFixPrSection(page);
    const targets = [
      fixPr.getByRole("link", { name: /^Fix PR #\d+$/ }),
      fixPr.getByRole("button", { name: "Open a Fix PR" }),
    ];
    await expect(targets[0]!).toBeVisible();
    await expectTargets(targets);
    await expectRings(page, targets);
  });
}

test("with reduced motion, the detail card holding the Fix PR appears without moving", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixPr = await openFixPrSection(page);
  await expect(fixPr.getByRole("link", { name: /^Fix PR #\d+$/ })).toBeVisible();
  expect(
    await page.locator(".detail-card").evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});

test("across this file, nothing was written to main, and nothing was merged, edited or deleted on GitHub", async () => {
  const branch = `warden/fix-${(await dahliaFinding()).id}`;
  const calls = logged();
  expect(calls.filter(isPullCreate)).toHaveLength(1);
  for (const call of calls) {
    const what = JSON.stringify(call);
    expect(["PATCH", "DELETE"], what).not.toContain(call.method);
    expect(call.path, what).not.toMatch(/\/merges?(\?|$)/);
    // A ref is only ever made, never moved: and only the Fix PR's branch, as is every commit.
    if (isRefCreate(call)) expect(call.body, what).toMatchObject({ ref: `refs/heads/${branch}` });
    if (call.path.includes("/git/refs/")) expect(call.method, what).toBe("GET");
    if (isContentsWrite(call)) expect(call.body, what).toMatchObject({ branch });
  }
});
