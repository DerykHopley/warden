// Story 1: an Admin connects GitHub from Setup. GitHub isn't reached: the App's settings (`/api/github/app`), GitHub's
// sign-in page and the link's answer are faked in the browser, so the test sees what the dashboard sends each of them.
// The rest is the real server on the seeded database: Acme has no repos linked.
// Story 2: Cedar's two Repo Assets and their stale Guard Scan (the global setup's), with nothing faked in the browser.
// The server has no GitHub settings, so the Scan Job it starts ends each Guard Scan failed: it has no way to read a repo.
// The global setup holds each Scan Job a few seconds before it runs, so the new Scan reads queued first.
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { ADA, CEDAR, CEDAR_REPOS, expect, GRACE, HEDY, KATHERINE, test } from "./session.ts";

const APP = { slug: "warden-reader", client_id: "Iv23li-e2e-client" };
const repo = (name: string) => ({
  asset: { kind: "repo", ref: `https://github.com/acme/${name}` },
  installation_id: 42,
  listed_at: "2026-11-25T09:00:00.000Z",
});
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

test("an Admin installs the app, signs in with GitHub and links installation 42 to the Team", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn(ADA);
  await page.route("**/api/github/app", (route) => route.fulfill({ json: APP }));
  let signInUrl: URL | undefined;
  // GitHub answers with a redirect; the fake answers with a page that sends the browser back the same way, as
  // WebKit's Playwright can't fulfill a route with a redirect status (#285).
  await page.route("https://github.com/login/oauth/authorize**", (route) => {
    signInUrl = new URL(route.request().url());
    const back = new URL("/setup/github/callback", baseURL);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", signInUrl.searchParams.get("state") ?? "");
    return route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(back.toString())})</script>`,
    });
  });
  const linkCalls: unknown[] = [];
  await page.route("**/api/github/installations", (route) => {
    linkCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { installation_id: 42, repos: [repo("web"), repo("api")], scan: null },
    });
  });

  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the GitHub app" })).toHaveAttribute(
    "href",
    "https://github.com/apps/warden-reader/installations/new",
  );

  // GitHub sends the Admin back to the App's Setup URL once the app is installed.
  await page.goto("/setup/github?installation_id=42&setup_action=install");
  await expect(page.getByText("Link installation 42 to Acme")).toBeVisible();
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();

  // The callback came back with the sign-in's own `state` (the fake GitHub above echoes it), and linked only because it
  // matched the kept attempt's; the code and state then left the address bar.
  await expect(page.getByText("Linked installation 42: 2 repos.")).toBeVisible();
  expect(page.url()).toBe(new URL("/setup/github/callback", baseURL).toString());
  expect(signInUrl?.searchParams.get("client_id")).toBe(APP.client_id);
  expect(signInUrl?.searchParams.get("state")).toBeTruthy();
  expect(signInUrl?.searchParams.get("code_challenge_method")).toBe("S256");
  // GitHub sends the Admin back to the origin they started on, a preview's included (#275).
  expect(signInUrl?.searchParams.get("redirect_uri")).toBe(
    new URL("/setup/github/callback", baseURL).toString(),
  );
  expect(linkCalls).toHaveLength(1);
  const sent = linkCalls[0] as { installation_id: number; code: string; code_verifier: string };
  expect(sent.installation_id).toBe(42);
  expect(sent.code).toBe("the-code");
  expect(s256(sent.code_verifier)).toBe(signInUrl?.searchParams.get("code_challenge"));
  await expect(page.getByRole("link", { name: "Back to Setup" })).toHaveAttribute("href", "/setup");
});

// Story 5 (#224): an Admin grants write access from Setup, with Warden's second GitHub app, the write app. The e2e
// server has no write-app settings, so the write app's settings and the grant's answer are faked in the browser, as
// story 1's are; GitHub's sign-in page is faked the same way.
const WRITE_APP = { slug: "warden-writer", client_id: "Iv23li-e2e-writer" };
type Sent = { installation_id: number; code: string; code_verifier: string };

/**
 * Fakes the write app's settings and GitHub's sign-in page, which echoes the sign-in's state back to its
 * `redirect_uri`, and answers the grant with `grant`. Returns what GitHub and the grant were sent.
 */
async function fakeWriteApp(page: Page, grant: (sent: Sent) => { status: number; json: unknown }) {
  const seen: { signInUrl?: URL; sent: Sent[] } = { sent: [] };
  await page.route("**/api/github/write-app", (route) => route.fulfill({ json: WRITE_APP }));
  await page.route("https://github.com/login/oauth/authorize**", (route) => {
    const signInUrl = new URL(route.request().url());
    seen.signInUrl = signInUrl;
    const back = new URL(signInUrl.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", signInUrl.searchParams.get("state") ?? "");
    return route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(back.toString())})</script>`,
    });
  });
  await page.route("**/api/github/write-installations", (route) => {
    const sent = route.request().postDataJSON() as Sent;
    seen.sent.push(sent);
    return route.fulfill(grant(sent));
  });
  return seen;
}

const writeAccess = (page: Page) => page.getByRole("region", { name: "Grant write access" });

test("an Admin installs the write app, signs in with GitHub and grants write access through installation 77 (story 5)", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn(ADA);
  const seen = await fakeWriteApp(page, (sent) => ({
    status: 201,
    json: {
      installation_id: sent.installation_id,
      granted_by: "user_ada",
      granted_at: "2026-11-26T09:14:00.000Z",
    },
  }));
  // The Team's grant as the server would answer it: none until the grant is made.
  await page.route("**/api/github/write-grant", (route) =>
    route.fulfill({
      json: {
        installations: seen.sent.map((sent) => ({
          installation_id: sent.installation_id,
          granted_by: "user_ada",
          granted_at: "2026-11-26T09:14:00.000Z",
        })),
      },
    }),
  );

  await page.goto("/setup");
  await expect(writeAccess(page).getByText("No write access granted.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the write app" })).toHaveAttribute(
    "href",
    "https://github.com/apps/warden-writer/installations/new",
  );

  // GitHub sends the Admin back to the write app's Setup URL once it is installed.
  await page.goto("/setup/github/write?installation_id=77&setup_action=install");
  await expect(page.getByRole("heading", { level: 1, name: "Grant write access" })).toBeVisible();
  await expect(page.getByText("Grant write access through installation 77 to Acme")).toBeVisible();
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();

  await expect(page.getByText("Write access granted through installation 77.")).toBeVisible();
  const callback = new URL("/setup/github/write/callback", baseURL).toString();
  expect(page.url()).toBe(callback);
  expect(seen.signInUrl?.searchParams.get("client_id")).toBe(WRITE_APP.client_id);
  expect(seen.signInUrl?.searchParams.get("state")).toBeTruthy();
  expect(seen.signInUrl?.searchParams.get("code_challenge_method")).toBe("S256");
  expect(seen.signInUrl?.searchParams.get("redirect_uri")).toBe(callback);
  expect(seen.sent).toHaveLength(1);
  expect(seen.sent[0]!.installation_id).toBe(77);
  expect(seen.sent[0]!.code).toBe("the-code");
  expect(s256(seen.sent[0]!.code_verifier)).toBe(
    seen.signInUrl?.searchParams.get("code_challenge"),
  );

  await page.getByRole("link", { name: "Back to Setup" }).click();
  await expect(
    writeAccess(page).getByText(/^Write access granted: installation 77, /),
  ).toBeVisible();
});

test("an Admin's grant refused by the server shows its words, and Setup still has no write access (story 5)", async ({
  page,
  signIn,
}) => {
  await signIn(ADA);
  const seen = await fakeWriteApp(page, () => ({
    status: 409,
    json: { error: "This installation's permissions aren't the write app's" },
  }));

  await page.goto("/setup/github/write?installation_id=77&setup_action=install");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "This installation's permissions aren't the write app's",
  );
  expect(seen.sent).toHaveLength(1);
  // The Team's grant from the real server, which no grant reached.
  await page.getByRole("link", { name: "Back to Setup" }).click();
  await expect(writeAccess(page).getByText("No write access granted.")).toBeVisible();
});

test("a Member sees an Admin grants write access, with no install link, and the Team's empty grant (story 5)", async ({
  page,
  signIn,
}) => {
  await signIn(GRACE);
  await page.goto("/setup");

  await expect(writeAccess(page).getByText("An Admin grants write access.")).toBeVisible();
  await expect(writeAccess(page).getByText("No write access granted.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the write app" })).toHaveCount(0);
});

/**
 * Each listed repo's row as [ref, last Scan words]. Read with `evaluate` on the list, never `evaluateAll`: Playwright
 * runs an `evaluateAll` locator in the page's own world, where naming the region (`ariaLabelledByElements`) crashes
 * Firefox's page process; `evaluate` finds the list in Playwright's isolated world first (#285).
 */
const repoRows = (page: Page) =>
  page
    .getByRole("region", { name: "Repos" })
    .getByRole("list")
    .evaluate((list) =>
      [...list.children].map((item) => [...item.children].map((part) => part.textContent ?? "")),
    );

test("an Admin starts Scan now and sees each repo's last Scan go from failed, through under way, to failed again (story 2)", async ({
  page,
  signIn,
}) => {
  // The Scan Job is a child process of the server, and the page reads the list again only every 5 s.
  test.setTimeout(60_000);
  await signIn(HEDY, CEDAR);
  const starts: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/scans") {
      starts.push(request.postDataJSON());
    }
  });
  // Held, not faked: the request goes on to the real server once the test has seen the busy button.
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/scans", async (route) => {
    await released;
    await route.continue();
  });

  await page.goto("/setup");
  const scanNow = page.getByRole("button", { name: "Scan now" });
  await expect(scanNow).toBeEnabled();
  const before = await repoRows(page);
  expect(before.map(([ref]) => ref)).toEqual(CEDAR_REPOS);
  for (const [, words] of before) expect(words).toMatch(/^Failed, /);

  await scanNow.click();
  await expect(scanNow).toHaveAttribute("aria-busy", "true");
  await expect(scanNow).toBeDisabled();
  // The list as the server answers it after the start, not only as the 202 named it. The e2e server holds each Scan
  // Job for a moment before it runs, so that answer can't come after the Job has already failed the Scan.
  const reread = page.waitForResponse(
    (res) => res.request().method() === "GET" && new URL(res.url()).pathname === "/api/repos",
  );
  release();
  await reread;

  await expect(page.getByText("A Scan is under way.")).toBeVisible();
  await expect(scanNow).toBeDisabled();
  for (const [, words] of await repoRows(page)) expect(words).toMatch(/^(Queued|Running)$/);
  expect(starts).toEqual([
    { module: "guard", assets: CEDAR_REPOS.map((ref) => ({ kind: "repo", ref })) },
  ]);

  // No reload: the page reads the list again every 5 s until the Scan ends.
  await expect(scanNow).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByText("A Scan is under way.")).toHaveCount(0);
  const after = await repoRows(page);
  for (const [i, [, words]] of after.entries()) {
    expect(words).toMatch(/^Failed, /);
    expect(words).not.toBe(before[i]![1]);
  }
  expect(starts).toHaveLength(1);
});

test("a Member sees each repo's last Scan, with no Scan now (story 2)", async ({
  page,
  signIn,
}) => {
  await signIn(KATHERINE, CEDAR);
  await page.goto("/setup");

  await expect(page.getByRole("region", { name: "Repos" }).getByRole("list")).toBeVisible();
  const rows = await repoRows(page);
  expect(rows.map(([ref]) => ref)).toEqual(CEDAR_REPOS);
  for (const [, words] of rows) expect(words).toMatch(/^(Queued|Running|Failed, .+|Done, .+)$/);
  await expect(page.getByRole("button", { name: "Scan now" })).toHaveCount(0);
});

test("a Member sees an Admin connects GitHub, with no install link", async ({ page, signIn }) => {
  await signIn(GRACE);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("link", { name: "Setup" })
    .click();

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText("An Admin connects GitHub.")).toBeVisible();
  await expect(page.getByText("No repos linked yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the GitHub app" })).toHaveCount(0);
});
