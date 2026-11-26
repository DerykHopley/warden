// The Setup page and GitHub's Setup URL (`/setup/github`), story 1: an Admin's install link, the Team's Repo Assets,
// and the sign-in button for the installation GitHub names. Each page renders alone with spy props over the fake API.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_SCAN_ASSETS, type Role, type ScanState } from "@warden/contracts";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ANSWERING, TEAM_NOT_OPENED } from "../src/api.ts";
import { dayAndTimeWords } from "../src/date-words.ts";
import { ATTEMPT_KEY, WRITE_ATTEMPT_KEY } from "../src/github-setup.ts";
import { goTo } from "../src/navigate.ts";
import { GitHubSetupPage, SetupPage, WriteAppSetupPage } from "../src/Setup.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));
vi.mock("../src/navigate.ts", () => ({ goTo: vi.fn() }));

const INSTALL_URL = "https://github.com/apps/warden-reader/installations/new";
const app = () => json(200, { slug: "warden-reader", client_id: "Iv23li-client" });
const ENDED = "2026-11-25T09:14:00.000Z";
const scan = (state: ScanState) => ({
  id: "0b6f1e9c-2d1f-4c55-9a3e-7f1d2c3b4a5e",
  module: "guard",
  state,
  assets: [{ kind: "repo", ref: "https://github.com/acme/web" }],
  rules: ["guard/secret-in-repo"],
  queued_at: "2026-11-25T09:00:00.000Z",
  started_at: state === "queued" ? null : "2026-11-25T09:00:20.000Z",
  ended_at: state === "done" || state === "failed" ? ENDED : null,
});
const repo = (name: string, lastScan: ScanState | null = null) => ({
  asset: { kind: "repo", ref: `https://github.com/acme/${name}` },
  installation_id: 42,
  listed_at: "2026-11-25T09:00:00.000Z",
  last_scan: lastScan === null ? null : scan(lastScan),
});
const reposOf =
  (...listed: ReturnType<typeof repo>[]) =>
  () =>
    json(200, { repos: listed });

beforeEach(() => {
  resetClerk();
  clerk.auth.isSignedIn = true;
  clerk.auth.orgId = "org_a";
  clerk.orgNames = { org_a: "Acme" };
  fetchMock.mockReset();
  vi.mocked(goTo).mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function props(role: Role) {
  return {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
}

/** The write app's routes Setup calls (#224, story 5), with no grant. */
const WRITE_INSTALL_URL = "https://github.com/apps/warden-writer/installations/new";
const writeApp = () => json(200, { slug: "warden-writer", client_id: "Iv23li-writer" });
const noGrants = () => json(200, { installations: [] });
const writeRoutes: Routes = { writeApp, writeGrant: noGrants };

function renderSetup(role: Role, routes: Routes = {}) {
  serve({ githubApp: app, repos: () => json(200, { repos: [] }), ...writeRoutes, ...routes });
  const given = props(role);
  const { rerender, unmount } = render(<SetupPage {...given} />);
  return { ...given, rerender, unmount };
}

const github = () => within(screen.getByRole("region", { name: "GitHub" }));
const repos = () => within(screen.getByRole("region", { name: "Repos" }));

describe("SetupPage", () => {
  it("shows an Admin the install link to the App's page on GitHub", async () => {
    renderSetup("admin");

    expect(screen.getByRole("heading", { level: 1, name: "Setup" })).toBeInTheDocument();
    expect(await github().findByRole("link", { name: "Install the GitHub app" })).toHaveAttribute(
      "href",
      INSTALL_URL,
    );
  });

  it("lists the Team's Repo Assets by ref, each with its last Scan in words", async () => {
    renderSetup("member", {
      repos: reposOf(
        repo("web"),
        repo("api", "queued"),
        repo("cli", "running"),
        repo("docs", "done"),
        repo("lib", "failed"),
      ),
    });

    const list = await repos().findByRole("list");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => [...item.children].map((part) => part.textContent)),
    ).toEqual([
      ["https://github.com/acme/web", "Never scanned"],
      ["https://github.com/acme/api", "Queued"],
      ["https://github.com/acme/cli", "Running"],
      ["https://github.com/acme/docs", `Done, ${dayAndTimeWords(ENDED)}`],
      ["https://github.com/acme/lib", `Failed, ${dayAndTimeWords(ENDED)}`],
    ]);
  });

  it("says no repos are linked yet when the Team has none", async () => {
    renderSetup("admin");

    expect(await repos().findByText("No repos linked yet.")).toBeInTheDocument();
  });

  it("shows the repos' waiting line, then their refusals as on People", async () => {
    renderSetup("admin", { repos: () => json(409, { error: "not opened" }) });

    expect(repos().getByText("Loading the Team's repos…")).toBeInTheDocument();
    expect(
      await repos().findByText(
        "Your Team's Admin must open Warden first. Try again once they have.",
      ),
    ).toBeInTheDocument();
  });

  it.each<Role>(["lead", "member"])(
    "tells a %s an Admin connects GitHub, with no install link and no call for the App",
    async (role) => {
      renderSetup(role);

      expect(github().getByText("An Admin connects GitHub.")).toBeInTheDocument();
      await repos().findByText("No repos linked yet.");
      expect(screen.queryByRole("link", { name: "Install the GitHub app" })).toBeNull();
      expect(callsTo("/api/github/app")).toEqual([]);
    },
  );

  it("tells an Admin GitHub isn't set up on this Warden when the App call answers 503, with no link", async () => {
    renderSetup("admin", {
      githubApp: () => json(503, { error: "GitHub isn't set up here" }),
    });

    expect(await github().findByText("GitHub isn't set up on this Warden.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Install the GitHub app" })).toBeNull();
  });

  it("when the App call answers 403, tells the Admin an Admin connects GitHub, and asks the shell for /api/me again once, after rendering", async () => {
    const errors = vi.spyOn(console, "error");
    serve({
      githubApp: () => json(403, { error: "Only an Admin can do this" }),
      repos: () => json(200, { repos: [] }),
      ...writeRoutes,
    });
    const refreshMe = vi.fn();
    // The shell's refreshMe changes the shell's state, as AppShell's does; its other props stay the same objects
    // across renders, as AppShell's do (a new getToken each render would ask the server again each render).
    function Shell() {
      const [given] = useState(() => props("admin"));
      const [, setAsked] = useState(0);
      const refresh = useCallback(() => {
        refreshMe();
        setAsked((n) => n + 1);
      }, []);
      return <SetupPage {...given} refreshMe={refresh} />;
    }
    render(<Shell />);

    expect(await github().findByText("An Admin connects GitHub.")).toBeInTheDocument();
    // refreshMe runs in an effect after the render that shows the text, so a busy runner can see the text first.
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledOnce());
    // Still once a moment later: the shell's new render doesn't ask again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it("shows the not-answering line with Retry when the App call answers 502, and the link after Retry", async () => {
    let answer = () => json(502, { error: "GitHub didn't answer" });
    renderSetup("admin", { githubApp: () => answer() });

    expect(await github().findByText("Warden's server isn't answering")).toBeInTheDocument();
    answer = app;
    await userEvent.click(github().getByRole("button", { name: "Retry" }));

    expect(
      await github().findByRole("link", { name: "Install the GitHub app" }),
    ).toBeInTheDocument();
  });
});

describe("SetupPage: Grant write access (#224, story 5)", () => {
  const write = () => within(screen.getByRole("region", { name: "Grant write access" }));
  const GRANTED_AT = "2026-11-26T09:14:00.000Z";
  const grant = (installationId: number) => ({
    installation_id: installationId,
    granted_by: "user_admin_secret_id",
    granted_at: GRANTED_AT,
  });

  it("sits between GitHub and Repos, and shows an Admin the write app's install link", async () => {
    renderSetup("admin");

    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "GitHub",
      "Grant write access",
      "Repos",
    ]);
    expect(write().getByText("Asking Warden's server about the write app…")).toBeInTheDocument();
    expect(await write().findByRole("link", { name: "Install the write app" })).toHaveAttribute(
      "href",
      WRITE_INSTALL_URL,
    );
  });

  it("tells an Admin Fix PRs aren't set up on this Warden when the write app answers 503, with no link", async () => {
    renderSetup("admin", {
      writeApp: () => json(503, { error: "Fix PRs aren't set up on this Warden" }),
    });

    expect(await write().findByText("Fix PRs aren't set up on this Warden.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Install the write app" })).toBeNull();
  });

  it("when the write app answers 403, tells the Admin an Admin grants write access, and asks for /api/me again", async () => {
    const { refreshMe } = renderSetup("admin", {
      writeApp: () => json(403, { error: "Only an Admin can do this" }),
    });

    expect(await write().findByText("An Admin grants write access.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Install the write app" })).toBeNull();
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledOnce());
  });

  it("shows the not-answering line with Retry when the write app answers 502, and the link after Retry", async () => {
    let answer = () => json(502, { error: "GitHub didn't answer" });
    renderSetup("admin", { writeApp: () => answer() });

    expect(await write().findByText("Warden's server isn't answering")).toBeInTheDocument();
    answer = writeApp;
    await userEvent.click(write().getByRole("button", { name: "Retry" }));

    expect(await write().findByRole("link", { name: "Install the write app" })).toBeInTheDocument();
  });

  it.each<Role>(["lead", "member"])(
    "tells a %s an Admin grants write access, with no link and no call for the write app",
    async (role) => {
      renderSetup(role);

      expect(write().getByText("An Admin grants write access.")).toBeInTheDocument();
      await write().findByText("No write access granted.");
      expect(screen.queryByRole("link", { name: "Install the write app" })).toBeNull();
      expect(callsTo("/api/github/write-app")).toEqual([]);
    },
  );

  it.each<Role>(["admin", "member"])(
    "shows a %s the Team's grant: none, then one line per installation, without who granted it",
    async (role) => {
      renderSetup(role);
      expect(write().getByText("Loading the Team's write access…")).toBeInTheDocument();
      expect(await write().findByText("No write access granted.")).toBeInTheDocument();
      cleanup();

      renderSetup(role, { writeGrant: () => json(200, { installations: [grant(42), grant(77)] }) });

      expect(
        await write().findByText(
          `Write access granted: installation 42, ${dayAndTimeWords(GRANTED_AT)}`,
        ),
      ).toBeInTheDocument();
      expect(
        write().getByText(`Write access granted: installation 77, ${dayAndTimeWords(GRANTED_AT)}`),
      ).toBeInTheDocument();
      expect(write().queryByText("No write access granted.")).toBeNull();
      expect(screen.queryByText(/user_admin_secret_id/)).toBeNull();
    },
  );

  it.each([
    ["Team not opened", () => json(409, { error: "not opened" }), TEAM_NOT_OPENED],
    [
      "no Team",
      () => json(403, { error: "no team" }),
      "Choose a Team first, from the switcher above.",
    ],
    [
      "too many attempts",
      () => json(429, { error: "too many" }, { "Retry-After": "120" }),
      "Too many sign-in attempts. Try again in 120 seconds.",
    ],
  ])("shows the grant's refusal when it can't be read: %s", async (_name, answer, words) => {
    renderSetup("member", { writeGrant: answer });

    expect(await write().findByText(words)).toBeInTheDocument();
  });

  it("shows the grant's not-answering line with Retry, and the grant after Retry", async () => {
    let answer = (): Response => {
      throw new TypeError("Failed to fetch");
    };
    renderSetup("member", { writeGrant: () => answer() });

    expect(await write().findByText("Warden's server isn't answering")).toBeInTheDocument();
    answer = noGrants;
    await userEvent.click(write().getByRole("button", { name: "Retry" }));

    expect(await write().findByText("No write access granted.")).toBeInTheDocument();
  });
});

describe("SetupPage: the write app's how-to (#224, story 16)", () => {
  const write = () => within(screen.getByRole("region", { name: "Grant write access" }));
  const HOW_TO = "How to set up the write app";
  const summary = () => write().getByText(HOW_TO);
  const howTo = () => summary().closest("details")!;
  const steps = () => within(howTo()).getAllByRole("heading", { level: 3 });
  const step = (n: number) => steps()[n - 1]!.closest("li")!;
  const STEPS = ["Register the app on GitHub", "Give Warden the keys", "Install and link it"];
  const notSetUp = () => json(503, { error: "Fix PRs aren't set up on this Warden" });

  it("on the write app's 503, shows the how-to open under the not-set-up line and above the grant, with its three steps in order", async () => {
    renderSetup("admin", { writeApp: notSetUp });

    const line = await write().findByText("Fix PRs aren't set up on this Warden.");
    expect(howTo()).toHaveAttribute("open");
    expect(steps().map((h) => h.textContent)).toEqual(STEPS);
    for (const n of [1, 2, 3]) expect(step(n)).toBeVisible();
    expect(line.compareDocumentPosition(howTo())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const grantLine = await write().findByText("No write access granted.");
    expect(howTo().compareDocumentPosition(grantLine)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("with the write app answering, shows the install link and the how-to closed; opening it shows the same steps", async () => {
    renderSetup("admin");

    const link = await write().findByRole("link", { name: "Install the write app" });
    expect(howTo()).not.toHaveAttribute("open");
    expect(step(1)).not.toBeVisible();
    expect(link.compareDocumentPosition(howTo())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.click(summary());

    expect(howTo()).toHaveAttribute("open");
    expect(steps().map((h) => h.textContent)).toEqual(STEPS);
    for (const n of [1, 2, 3]) expect(step(n)).toBeVisible();
  });

  it.each([
    [
      "while the write app's call waits",
      () => deferred<Response>().promise,
      "Asking Warden's server about the write app…",
    ],
    [
      "on its 403",
      () => json(403, { error: "Only an Admin can do this" }),
      "An Admin grants write access.",
    ],
    [
      "when it doesn't answer",
      () => json(502, { error: "GitHub didn't answer" }),
      "Warden's server isn't answering",
    ],
  ])("shows an Admin the how-to closed %s", async (_name, answer, words) => {
    renderSetup("admin", { writeApp: answer });

    expect(await write().findByText(words)).toBeInTheDocument();
    expect(summary()).toBeInTheDocument();
    expect(howTo()).not.toHaveAttribute("open");
  });

  it.each<Role>(["lead", "member"])(
    "gives a %s no how-to, and no call for the write app",
    async (role) => {
      renderSetup(role);

      await write().findByText("No write access granted.");
      expect(screen.queryByText(HOW_TO)).toBeNull();
      expect(write().getByText("An Admin grants write access.")).toBeInTheDocument();
      expect(callsTo("/api/github/write-app")).toEqual([]);
    },
  );

  it("step 1 names this page's own URLs, the three permissions with why, and nothing more", async () => {
    renderSetup("admin", { writeApp: notSetUp });
    await write().findByText("Fix PRs aren't set up on this Warden.");

    const register = within(step(1));
    const origin = location.origin;
    for (const url of [
      origin,
      `${origin}/setup/github/write/callback`,
      `${origin}/setup/github/write`,
    ]) {
      expect(register.getByText(url).tagName).toBe("CODE");
    }
    const words = step(1).textContent;
    for (const part of [
      "Settings, Developer settings, GitHub Apps, New GitHub App",
      "apart from the read-only one",
      `Homepage URL: ${origin}`,
      `Callback URL: ${origin}/setup/github/write/callback`,
      `Setup URL: ${origin}/setup/github/write`,
      'Leave "Request user authorization (OAuth) during installation" cleared',
      'clear "Active". The write app has no webhooks.',
      "these three and nothing else",
      "Contents: Read and write, to make the Fix PR's branch and commit its edit.",
      "Pull requests: Read and write, to open the Fix PR and find one already open.",
      "Metadata: Read-only, which GitHub requires for every app.",
      "No account or organization permissions, and no Workflows.",
      "never .github/workflows/",
      "Warden refuses to link an installation that holds any other permission, or lacks one of these three.",
      "generate a client secret and a private key",
    ]) {
      expect(words).toContain(part);
    }
  });

  it("step 2 names the server's three variables, where each comes from, and the restart", async () => {
    renderSetup("admin", { writeApp: notSetUp });
    await write().findByText("Fix PRs aren't set up on this Warden.");

    const keys = within(step(2));
    for (const name of [
      "GITHUB_WRITE_APP_CLIENT_ID",
      "GITHUB_WRITE_APP_CLIENT_SECRET",
      "GITHUB_WRITE_APP_PRIVATE_KEY",
      ".envrc",
    ]) {
      expect(keys.getByText(name).tagName).toBe("CODE");
    }
    const words = step(2).textContent;
    for (const part of [
      "all three or none",
      "Locally they come from the keyring through .envrc.",
      "On Cloud Run they come from Secret Manager, with the client id as a repository variable.",
      "restart the server",
    ]) {
      expect(words).toContain(part);
    }
  });

  it("step 3 says to install the app, then sign in with GitHub on the Grant write access page", async () => {
    renderSetup("admin", { writeApp: notSetUp });
    await write().findByText("Fix PRs aren't set up on this Warden.");

    const words = step(3).textContent;
    for (const part of [
      'Choose "Install the write app" above',
      "whose repos should get Fix PRs",
      'Choose "Sign in with GitHub" there.',
    ]) {
      expect(words).toContain(part);
    }
  });

  it("stays as the person left it when the write app is asked again and the grant is read again", async () => {
    const { rerender, ...given } = renderSetup("admin", { writeApp: notSetUp });
    await write().findByText("Fix PRs aren't set up on this Warden.");
    expect(howTo()).toHaveAttribute("open");

    await userEvent.click(summary());
    expect(howTo()).not.toHaveAttribute("open");
    // A new getToken asks both routes again: the write app's answer comes in again, 503 as before.
    rerender(
      <SetupPage {...given} getToken={vi.fn(async () => "session-token" as string | null)} />,
    );

    await vi.waitFor(() => expect(callsTo("/api/github/write-app")).toHaveLength(2));
    await vi.waitFor(() => expect(callsTo("/api/github/write-grant")).toHaveLength(2));
    await write().findByText("Fix PRs aren't set up on this Warden.");
    expect(howTo()).not.toHaveAttribute("open");
  });
});

describe("SetupPage: Scan now (story 2)", () => {
  const scanNow = () => repos().getByRole("button", { name: "Scan now" });
  const UNDER_WAY = "A Scan is under way.";

  it.each<Role>(["lead", "admin"])("gives a %s Scan now above the repo list", async (role) => {
    renderSetup(role, { repos: reposOf(repo("web", "done")) });

    const button = await repos().findByRole("button", { name: "Scan now" });
    expect(button).toBeEnabled();
    expect(button.compareDocumentPosition(repos().getByRole("list"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("gives a Member each repo's last Scan and no Scan now", async () => {
    renderSetup("member", { repos: reposOf(repo("web", "done")) });

    await repos().findByRole("list");
    expect(repos().queryByRole("button", { name: "Scan now" })).toBeNull();
  });

  it("shows no Scan now while the list loads, or with no repos", async () => {
    renderSetup("admin");

    expect(repos().getByText("Loading the Team's repos…")).toBeInTheDocument();
    expect(repos().queryByRole("button", { name: "Scan now" })).toBeNull();
    await repos().findByText("No repos linked yet.");
    expect(repos().queryByRole("button", { name: "Scan now" })).toBeNull();
  });

  it("shows no Scan now when the list can't be read", async () => {
    renderSetup("admin", { repos: () => json(409, { error: "not opened" }) });

    expect(await repos().findByText(TEAM_NOT_OPENED)).toBeInTheDocument();
    expect(repos().queryByRole("button", { name: "Scan now" })).toBeNull();
  });

  it("starts one Guard Scan of the first MAX_SCAN_ASSETS repos in the list's order, busy until it answers, then reads the list again", async () => {
    const listed = Array.from({ length: MAX_SCAN_ASSETS + 1 }, (_, i) =>
      repo(`r${String(i).padStart(3, "0")}`, "done"),
    );
    let answer = reposOf(...listed);
    const started = deferred<Response>();
    renderSetup("lead", { repos: () => answer(), startScan: () => started.promise });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    expect(scanNow()).toBeDisabled();
    expect(scanNow()).toHaveAttribute("aria-busy", "true");
    expect(callsTo("/api/scans")).toHaveLength(1);
    expect(JSON.parse(String(callsTo("/api/scans")[0]![1]?.body))).toEqual({
      module: "guard",
      assets: listed.slice(0, MAX_SCAN_ASSETS).map((listedRepo) => listedRepo.asset),
    });

    answer = reposOf(...listed.map((listedRepo) => ({ ...listedRepo, last_scan: scan("queued") })));
    started.resolve(json(202, scan("queued")));

    expect(await repos().findByText(UNDER_WAY)).toBeInTheDocument();
    expect(callsTo("/api/repos")).toHaveLength(2);
    expect(scanNow()).toBeDisabled();
    expect(scanNow()).not.toHaveAttribute("aria-busy", "true");
  });

  it("reads the started repos as queued from the 202 at once, so a click before the list answers again sends nothing", async () => {
    const reread = deferred<Response>();
    let reads = 0;
    renderSetup("admin", {
      repos: () =>
        reads++ === 0 ? reposOf(repo("web", "done"), repo("api", "done"))() : reread.promise,
      startScan: () => json(202, scan("queued")),
    });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    expect(await repos().findByText(UNDER_WAY)).toBeInTheDocument();
    expect(repos().getByText("Queued")).toBeInTheDocument();
    expect(repos().getByText(`Done, ${dayAndTimeWords(ENDED)}`)).toBeInTheDocument();
    expect(scanNow()).toBeDisabled();
    await userEvent.click(scanNow());
    expect(callsTo("/api/scans")).toHaveLength(1);
    expect(callsTo("/api/repos")).toHaveLength(2);
  });

  it("sends nothing for a second click while the first start runs", async () => {
    const started = deferred<Response>();
    renderSetup("admin", {
      repos: reposOf(repo("web", "done")),
      startScan: () => started.promise,
    });
    const button = await repos().findByRole("button", { name: "Scan now" });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(callsTo("/api/scans")).toHaveLength(1);
    started.resolve(json(202, scan("queued")));
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(2));
  });

  it("is disabled with 'A Scan is under way.' while a listed repo's last Scan is queued or running", async () => {
    renderSetup("lead", { repos: reposOf(repo("web", "done"), repo("api", "running")) });

    expect(await repos().findByText(UNDER_WAY)).toBeInTheDocument();
    expect(scanNow()).toBeDisabled();
  });

  // A 400 may answer a list gone stale (a repo the Team no longer holds), so the list is read again after it.
  it.each([
    [
      "a 400, in the server's words",
      () => json(400, { error: "assets: not the Team's" }),
      "assets: not the Team's",
      2,
    ],
    ["a 400 with no words", () => json(400, {}), "Warden couldn't start the Scan.", 2],
    [
      "a 503, in the server's words",
      () => json(503, { error: "Scans aren't set up here" }),
      "Scans aren't set up here",
      1,
    ],
    ["a 409", () => json(409, { error: "not opened" }), TEAM_NOT_OPENED, 1],
    [
      "a 429 with Retry-After: 120",
      () => json(429, { error: "too many" }, { "Retry-After": "120" }),
      "Too many tries: try again in 2 min",
      1,
    ],
    [
      "no answer",
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
      NOT_ANSWERING,
      1,
    ],
  ])(
    "shows %s in the refusal line under the button, and gives the button back",
    async (_name, refusal, words, reads) => {
      renderSetup("lead", { repos: reposOf(repo("web", "done")), startScan: refusal });

      await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

      expect(await repos().findByRole("alert")).toHaveTextContent(words);
      expect(scanNow()).toBeEnabled();
      expect(scanNow()).not.toHaveAttribute("aria-busy", "true");
      await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(reads));
    },
  );

  // The server may have stored the Scan before it failed, so the list is read again, as after a 502.
  it.each([
    [
      "a 500, in the server's words",
      () => json(500, { error: "Something broke" }),
      "Something broke",
    ],
    [
      "a 500 with no words",
      () => new Response("Internal Server Error", { status: 500 }),
      "Warden couldn't start the Scan.",
    ],
    ["a 504 with no words", () => json(504, {}), "Warden couldn't start the Scan."],
  ])("shows %s and reads the list again", async (_name, refusal, words) => {
    renderSetup("lead", { repos: reposOf(repo("web", "done")), startScan: refusal });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    expect(await repos().findByRole("alert")).toHaveTextContent(words);
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(2));
    expect(scanNow()).toBeEnabled();
  });

  it("shows a 502's words and reads the list again", async () => {
    let answer = reposOf(repo("web", "done"));
    renderSetup("lead", {
      repos: () => answer(),
      startScan: () => {
        answer = reposOf(repo("web", "failed"));
        return json(502, { error: "The Scan couldn't be started" });
      },
    });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    expect(await repos().findByRole("alert")).toHaveTextContent("The Scan couldn't be started");
    await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(2));
    expect(await repos().findByText(`Failed, ${dayAndTimeWords(ENDED)}`)).toBeInTheDocument();
    expect(scanNow()).toBeEnabled();
  });

  it("on a 403, says only a Lead or an Admin starts a Scan and asks /api/me again", async () => {
    const { refreshMe } = renderSetup("lead", {
      repos: reposOf(repo("web", "done")),
      startScan: () => json(403, { error: "Only a lead can do this" }),
    });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    expect(await repos().findByRole("alert")).toHaveTextContent(
      "Only a Lead or an Admin starts a Scan.",
    );
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(scanNow()).toBeEnabled();
  });

  it("ends the session when the start answers 401", async () => {
    const { onSessionEnded } = renderSetup("lead", {
      repos: reposOf(repo("web", "done")),
      startScan: () => json(401, { error: "signed out" }),
    });

    await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));

    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  describe("reading the list again while a Scan is under way", () => {
    // Only the timeouts are fake: vi.waitFor moves them on 50 ms for each check it makes.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it("reads GET /api/repos every 5 s while a listed Scan is queued or running, and stops once all are done or failed", async () => {
      const states: ScanState[] = ["queued", "running", "failed"];
      let reads = 0;
      renderSetup("member", {
        repos: () => reposOf(repo("web", states[Math.min(reads++, states.length - 1)]!))(),
      });
      await vi.waitFor(() => expect(repos().getByText("Queued")).toBeInTheDocument());

      await act(() => vi.advanceTimersByTimeAsync(4_800));
      expect(callsTo("/api/repos")).toHaveLength(1);
      await act(() => vi.advanceTimersByTimeAsync(300));
      await vi.waitFor(() => expect(repos().getByText("Running")).toBeInTheDocument());
      expect(callsTo("/api/repos")).toHaveLength(2);

      await act(() => vi.advanceTimersByTimeAsync(5_100));
      await vi.waitFor(() =>
        expect(repos().getByText(`Failed, ${dayAndTimeWords(ENDED)}`)).toBeInTheDocument(),
      );
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(callsTo("/api/repos")).toHaveLength(3);
    });

    it("keeps the last list on screen, and reading every 5 s, when one read while a Scan is under way fails", async () => {
      const answers = [
        reposOf(repo("web", "queued")),
        () => json(502, { error: "Bad gateway" }),
        reposOf(repo("web", "failed")),
      ];
      let reads = 0;
      renderSetup("member", { repos: () => answers[Math.min(reads++, answers.length - 1)]!() });
      await vi.waitFor(() => expect(repos().getByText("Queued")).toBeInTheDocument());

      await act(() => vi.advanceTimersByTimeAsync(5_100));
      await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(2));
      expect(repos().getByText("Queued")).toBeInTheDocument();
      expect(repos().queryByRole("alert")).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(5_100));
      await vi.waitFor(() =>
        expect(repos().getByText(`Failed, ${dayAndTimeWords(ENDED)}`)).toBeInTheDocument(),
      );
      expect(callsTo("/api/repos")).toHaveLength(3);
    });

    it("stops reading once the page is gone", async () => {
      const { unmount } = renderSetup("member", { repos: reposOf(repo("web", "running")) });
      await vi.waitFor(() => expect(repos().getByText("Running")).toBeInTheDocument());

      unmount();
      await act(() => vi.advanceTimersByTimeAsync(20_000));

      expect(callsTo("/api/repos")).toHaveLength(1);
    });
  });
});

function renderGitHubSetup(search: string, role: Role = "admin", routes: Routes = {}) {
  window.history.replaceState(null, "", `/setup/github${search}`);
  serve({ githubApp: app, ...routes });
  render(<GitHubSetupPage {...props(role)} />);
}

describe("GitHubSetupPage", () => {
  // What GitHub's sign-in URL holds is `signInUrl`'s, tested in github-setup.test.ts.
  it("asks an Admin to link GitHub's installation to the Team, and leaves for GitHub's sign-in with an attempt for it", async () => {
    renderGitHubSetup("?installation_id=42&setup_action=install");

    expect(screen.getByText("Link installation 42 to Acme")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));

    await vi.waitFor(() => expect(goTo).toHaveBeenCalledOnce());
    expect(vi.mocked(goTo).mock.calls[0]![0]).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/,
    );
    const kept = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY)!) as Record<string, unknown>;
    expect(kept.installationId).toBe(42);
  });

  it("when this browser can't keep the attempt, says so in an alert and gives the button back", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The storage is blocked", "SecurityError");
    });
    renderGitHubSetup("?installation_id=42&setup_action=install");

    const button = await screen.findByRole("button", { name: "Sign in with GitHub" });
    await userEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This browser couldn't start the GitHub sign-in. Allow this site to store data for this tab, and open Warden over https.",
    );
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy", "true");
    expect(goTo).not.toHaveBeenCalled();
  });

  it.each([
    ["no installation_id", "?setup_action=install"],
    ["installation_id=abc", "?installation_id=abc&setup_action=install"],
  ])(
    "with %s, tells an Admin GitHub didn't say which installation, with the install link and no sign-in button",
    async (_name, search) => {
      renderGitHubSetup(search);

      expect(
        screen.getByText("GitHub didn't say which installation. Install the app again."),
      ).toBeInTheDocument();
      expect(await screen.findByRole("link", { name: "Install the GitHub app" })).toHaveAttribute(
        "href",
        INSTALL_URL,
      );
      expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    },
  );

  it.each<Role>(["lead", "member"])(
    "tells a %s only an Admin links GitHub, with no button and no call",
    (role) => {
      renderGitHubSetup("?installation_id=42&setup_action=install", role);

      expect(screen.getByText("Only an Admin links GitHub to the Team.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
      expect(callsTo("/api/github/app")).toEqual([]);
    },
  );

  it("tells an Admin GitHub isn't set up on this Warden when the App call answers 503, with no button", async () => {
    renderGitHubSetup("?installation_id=42", "admin", {
      githubApp: () => json(503, { error: "GitHub isn't set up here" }),
    });

    expect(await screen.findByText("GitHub isn't set up on this Warden.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  });
});

function renderWriteSetup(search: string, role: Role = "admin", routes: Routes = {}) {
  window.history.replaceState(null, "", `/setup/github/write${search}`);
  serve({ writeApp, ...routes });
  const given = props(role);
  render(<WriteAppSetupPage {...given} />);
  return given;
}

describe("WriteAppSetupPage (#224, story 5)", () => {
  it("asks an Admin to grant write access through GitHub's installation, and leaves for the write app's sign-in", async () => {
    renderWriteSetup("?installation_id=42&setup_action=install");

    expect(
      screen.getByRole("heading", { level: 1, name: "Grant write access" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Grant write access through installation 42 to Acme"),
    ).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));

    await vi.waitFor(() => expect(goTo).toHaveBeenCalledOnce());
    const url = new URL(vi.mocked(goTo).mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv23li-writer");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${window.location.origin}/setup/github/write/callback`,
    );
    const kept = JSON.parse(sessionStorage.getItem(WRITE_ATTEMPT_KEY)!) as Record<string, unknown>;
    expect(kept.installationId).toBe(42);
    expect(url.searchParams.get("state")).toBe(kept.state);
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
    expect(callsTo("/api/github/app")).toEqual([]);
  });

  it.each([
    ["no installation_id", "?setup_action=install"],
    ["installation_id=0", "?installation_id=0&setup_action=install"],
    ["installation_id=abc", "?installation_id=abc&setup_action=install"],
  ])(
    "with %s, tells an Admin GitHub didn't say which installation, with the write app's install link",
    async (_name, search) => {
      renderWriteSetup(search);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "GitHub didn't say which installation. Install the write app again.",
      );
      expect(await screen.findByRole("link", { name: "Install the write app" })).toHaveAttribute(
        "href",
        WRITE_INSTALL_URL,
      );
      expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    },
  );

  it.each<Role>(["lead", "member"])(
    "tells a %s only an Admin grants write access, with no button and no call",
    (role) => {
      renderWriteSetup("?installation_id=42&setup_action=install", role);

      expect(
        screen.getByText("Only an Admin grants write access to the Team."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
      expect(callsTo("/api/github/write-app")).toEqual([]);
    },
  );

  // The words and the 403's refreshMe are the Setup section's, tested above; here, only that no button is offered.
  it.each([
    [503, "Fix PRs aren't set up on this Warden."],
    [403, "An Admin grants write access."],
  ])("when the write app answers %i, offers an Admin no sign-in button", async (status, words) => {
    renderWriteSetup("?installation_id=42", "admin", {
      writeApp: () => json(status, { error: "Refused" }),
    });

    await screen.findByText(words);
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  });
});
