// Story 1: an Admin connects GitHub from Setup. GitHub isn't reached: the App's settings (`/api/github/app`), GitHub's
// sign-in page and the link's answer are faked in the browser, so the test sees what the dashboard sends each of them.
// The rest is the real server on the seeded database: Acme has no repos linked.
import { createHash } from "node:crypto";
import { expect, GRACE, ADA, test } from "./session.ts";

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
  await page.route("https://github.com/login/oauth/authorize**", (route) => {
    signInUrl = new URL(route.request().url());
    const back = new URL("/setup/github/callback", baseURL);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", signInUrl.searchParams.get("state") ?? "");
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  const linkCalls: unknown[] = [];
  await page.route("**/api/github/installations", (route) => {
    linkCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { installation_id: 42, repos: [repo("web"), repo("api")] },
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
  expect(linkCalls).toHaveLength(1);
  const sent = linkCalls[0] as { installation_id: number; code: string; code_verifier: string };
  expect(sent.installation_id).toBe(42);
  expect(sent.code).toBe("the-code");
  expect(s256(sent.code_verifier)).toBe(signInUrl?.searchParams.get("code_challenge"));
  await expect(page.getByRole("link", { name: "Back to Setup" })).toHaveAttribute("href", "/setup");
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
