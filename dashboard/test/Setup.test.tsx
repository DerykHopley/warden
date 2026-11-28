// The Setup page and GitHub's Setup URL (`/setup/github`), story 1: an Admin's install link, the Team's Repo Assets,
// and the sign-in button for the installation GitHub names. Each page renders alone with spy props over the fake API.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HOOK_TOKEN_PLACEHOLDER,
  MAX_SCAN_ASSETS,
  type PrivacyTier,
  type Role,
  type ScanState,
} from "@warden/contracts";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ANSWERING, TEAM_NOT_OPENED } from "../src/api.ts";
import { dayAndTimeWords } from "../src/date-words.ts";
import { ATTEMPT_KEY, WRITE_ATTEMPT_KEY } from "../src/github-setup.ts";
import { goTo } from "../src/navigate.ts";
import { GitHubSetupPage, SetupPage, WriteAppSetupPage } from "../src/Setup.tsx";
import { cataloguesChanged } from "../src/vouch.ts";
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
    panel: { setContext: vi.fn(), open: vi.fn(), uncover: vi.fn() },
  };
}

/** The write app's routes Setup calls (#224, story 5), with no grant. */
const WRITE_INSTALL_URL = "https://github.com/apps/warden-writer/installations/new";
const writeApp = () => json(200, { slug: "warden-writer", client_id: "Iv23li-writer" });
const noGrants = () => json(200, { installations: [] });
const writeRoutes: Routes = { writeApp, writeGrant: noGrants };

/** VDA ISA 2027.1 as `GET /api/vouch/catalogues` answers it (spec #341, slice 5): off, as no Admin ever set it. */
const SET_AT = "2026-11-26T09:14:00.000Z";
const SET_BY = "user_admin_secret_id";
const CATALOGUE = {
  id: "vda-isa-2027.1",
  name: "VDA ISA 2027.1",
  date: "2026-09-30",
  credit: "© 2026 ENX Association, registered in France.",
  licence: "CC BY-ND 4.0",
  licence_url: "https://creativecommons.org/licenses/by-nd/4.0/",
  on: false,
  set_by: null as string | null,
  set_at: null as string | null,
  controls: ["1.3.3", "1.3.4", "4.1.3", "5.2.4"].map((ref) => ({
    ref,
    question: `Question ${ref}?`,
    iso_27001: "A.5.1",
  })),
};
const catalogueSet = (on: boolean) => ({ ...CATALOGUE, on, set_by: SET_BY, set_at: SET_AT });
const cataloguesOf =
  (...listed: (typeof CATALOGUE)[]) =>
  () =>
    json(200, { catalogues: listed });

/** The managed-settings block as the server builds it (story 7): every tier's events, and Content's prompts. */
const hookBlock = (tier: PrivacyTier, token: string = HOOK_TOKEN_PLACEHOLDER) => {
  const hook = {
    type: "http",
    url: "https://warden.example/api/hook/events",
    headers: { Authorization: `Bearer ${token}`, "X-Warden-Developer": "$USER" },
    allowedEnvVars: ["USER"],
    timeout: 5,
  };
  const events = ["PostToolUse", "PostToolUseFailure", "SessionEnd"];
  if (tier === "content") events.push("UserPromptSubmit");
  return { hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [hook] }]])) };
};
const ISSUED_AT = "2026-11-26T09:14:00.000Z";
const PREVIOUS_UNTIL = "2026-11-27T09:14:00.000Z";
/** `GET /api/hook`'s body: no token yet, at Details, unless a test says otherwise. */
const hookSettings = ({
  issuedAt = null as string | null,
  previousUntil = null as string | null,
  tier = "details" as PrivacyTier,
} = {}) => ({
  token: issuedAt === null ? null : { issued_at: issuedAt },
  previous_valid_until: previousUntil,
  privacy_tier: tier,
  managed_settings: hookBlock(tier),
});
const noHookToken = () => json(200, hookSettings());

/** What Setup's sections ask for when it opens, as `renderSetup` answers each unless a test says otherwise. */
const SETUP_ROUTES = {
  githubApp: app,
  repos: () => json(200, { repos: [] }),
  writeApp,
  writeGrant: noGrants,
  catalogues: cataloguesOf(CATALOGUE),
  hook: noHookToken,
  judgeModel: () => json(200, { local_model: null }),
} satisfies Routes;

function renderSetup(role: Role, routes: Routes = {}) {
  serve({
    // The Team check a Catalogue switch asks before its PUT: the session is in Acme, as `props` says.
    me: () => json(200, { userId: "user_1", team: "org_a", role, level: "quick" }),
    ...SETUP_ROUTES,
    ...routes,
  });
  const given = props(role);
  const { rerender, unmount } = render(<SetupPage {...given} />);
  return { ...given, rerender, unmount };
}

const github = () => within(screen.getByRole("region", { name: "GitHub" }));
const repos = () => within(screen.getByRole("region", { name: "Repos" }));
const grantWrite = () => within(screen.getByRole("region", { name: "Grant write access" }));

/**
 * What each asking section but the Catalogues shows once its call has answered, as `SETUP_ROUTES` answers it: the
 * landing tests wait on each but the one they hold.
 */
const ANSWERED_BY = {
  githubApp: () => github().findByRole("link", { name: "Install the GitHub app" }),
  writeApp: () => grantWrite().findByRole("link", { name: "Install the write app" }),
  writeGrant: () => grantWrite().findByText("No write access granted."),
  repos: () => repos().findByText("No repos linked yet."),
  hook: () =>
    within(screen.getByRole("region", { name: "Agent hook" })).findByText("No hook token yet."),
  judgeModel: () =>
    within(screen.getByRole("region", { name: "Judge's model" })).findByText(
      "The Judge calls OpenRouter (the default).",
    ),
};

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
      "Catalogues",
      "Agent hook",
      "Judge's model",
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

  it("when both apps answer 403, asks for /api/me again once, for both sections (#325)", async () => {
    const forbidden = () => json(403, { error: "Only an Admin can do this" });
    const { refreshMe } = renderSetup("admin", { githubApp: forbidden, writeApp: forbidden });

    expect(await github().findByText("An Admin connects GitHub.")).toBeInTheDocument();
    expect(await write().findByText("An Admin grants write access.")).toBeInTheDocument();
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalled());
    // Both sections' effects have run once both lines show and React has settled.
    await act(async () => {});
    expect(refreshMe).toHaveBeenCalledOnce();
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
    "tells a %s an Admin grants write access, with no link, no how-to (story 16) and no call for the write app",
    async (role) => {
      renderSetup(role);

      expect(write().getByText("An Admin grants write access.")).toBeInTheDocument();
      await write().findByText("No write access granted.");
      expect(screen.queryByRole("link", { name: "Install the write app" })).toBeNull();
      expect(screen.queryByText("How to set up the write app")).toBeNull();
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

  describe("opened at #setup-repos, Findings' Scan now link (#342)", () => {
    // jsdom lays nothing out, so it has no scrollIntoView: each test gives Element one, and records what it was called on.
    const scrolled = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();
    beforeEach(() => {
      scrolled.mockReset();
      Element.prototype.scrollIntoView = scrolled;
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it("brings the Repos heading into view once the list answers, and not again when the list is read again", async () => {
      window.history.replaceState(null, "", "/setup#setup-repos");
      const list = deferred<Response>();
      let reads = 0;
      renderSetup("lead", {
        repos: () => (reads++ === 0 ? list.promise : reposOf(repo("web", "queued"))()),
        startScan: () => json(202, scan("queued")),
      });

      await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(1));
      expect(scrolled).not.toHaveBeenCalled();
      list.resolve(reposOf(repo("web", "done"))());

      await userEvent.click(await repos().findByRole("button", { name: "Scan now" }));
      await vi.waitFor(() => expect(callsTo("/api/repos")).toHaveLength(2));
      await repos().findByText("A Scan is under way.");

      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(
        screen.getByRole("heading", { level: 2, name: "Repos" }),
      );
    });

    it("scrolls nothing when the address has no #setup-repos", async () => {
      window.history.replaceState(null, "", "/setup");
      renderSetup("lead", { repos: reposOf(repo("web", "done")) });

      await repos().findByRole("button", { name: "Scan now" });
      expect(scrolled).not.toHaveBeenCalled();
    });
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

describe("SetupPage: Catalogues (spec #341, slice 5)", () => {
  const catalogues = () => within(screen.getByRole("region", { name: "Catalogues" }));
  const entry = () => within(catalogues().getByRole("listitem"));
  /** The entry, once the list has answered. */
  const shown = async () => within(await catalogues().findByRole("listitem"));
  const PATH = "/api/vouch/catalogues/vda-isa-2027.1";
  const ON_WORDS = "On: Vouch checks 4 Controls: 1.3.3, 1.3.4, 4.1.3, 5.2.4.";
  const ADMIN_DOES = "An Admin turns a Catalogue on or off.";
  const sent = () =>
    callsTo(PATH).map(([, init]) => [init?.method, JSON.parse(String(init?.body))]);
  /** A switch route that answers the Catalogue as the body set it. */
  const switched = (_id: string, body: unknown) =>
    json(200, catalogueSet((body as { on: boolean }).on));
  /**
   * The list and the switch over one stored Catalogue, as the server keeps it: each switch sets it (once `answer`
   * settles, when given) and answers it, and the list reads it back.
   */
  const storing = (answer?: Promise<void>): Routes => {
    let stored = CATALOGUE;
    return {
      catalogues: () => json(200, { catalogues: [stored] }),
      switchCatalogue: async (_id, body) => {
        await answer;
        stored = catalogueSet((body as { on: boolean }).on);
        return json(200, stored);
      },
    };
  };

  it("shows an Admin the Catalogue by name and date, off, with Turn on", async () => {
    renderSetup("admin");

    expect(catalogues().getByText("Loading the Team's Catalogues…")).toBeInTheDocument();
    expect(
      await (await shown()).findByText("VDA ISA 2027.1, published Sep 30, 2026"),
    ).toBeInTheDocument();
    expect(entry().getByText("Off.")).toBeInTheDocument();
    expect(entry().queryByText(/^Turned/)).toBeNull();
    expect(entry().getByRole("button", { name: "Turn on" })).toHaveClass("primary");
  });

  it("turns it on with { on: true }, then off with { on: false }, showing each answer, and reading the list again after each", async () => {
    renderSetup("admin", storing());

    await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

    expect(await (await shown()).findByText(ON_WORDS)).toBeInTheDocument();
    expect(entry().getByText(`Turned on ${dayAndTimeWords(SET_AT)}`)).toHaveClass("muted");
    const turnOff = entry().getByRole("button", { name: "Turn off" });
    expect(turnOff).toHaveClass("secondary");

    await userEvent.click(turnOff);

    expect(await (await shown()).findByText("Off.")).toBeInTheDocument();
    expect(entry().getByText(`Turned off ${dayAndTimeWords(SET_AT)}`)).toBeInTheDocument();
    expect(entry().getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    expect(sent()).toEqual([
      ["PUT", { on: true }],
      ["PUT", { on: false }],
    ]);
    await vi.waitFor(() => expect(callsTo("/api/vouch/catalogues")).toHaveLength(3));
  });

  it("shows the switch's answer, not an older read a dropped switch started that answers after it", async () => {
    const older = deferred<Response>();
    let reads = 0;
    renderSetup("admin", {
      catalogues: () => {
        reads++;
        if (reads === 2) return older.promise;
        return json(200, { catalogues: [reads === 1 ? CATALOGUE : catalogueSet(true)] });
      },
      switchCatalogue: switched,
    });
    const turnOn = await (await shown()).findByRole("button", { name: "Turn on" });

    // A switch sent from a Setup a Team switch replaced lands: this page reads the list again, and that read is slow.
    act(() => cataloguesChanged("org_a"));
    await vi.waitFor(() => expect(reads).toBe(2));
    await userEvent.click(turnOn);
    expect(await (await shown()).findByText(ON_WORDS)).toBeInTheDocument();
    await act(async () => older.resolve(json(200, { catalogues: [CATALOGUE] })));

    expect(entry().getByText(ON_WORDS)).toBeInTheDocument();
    expect(entry().queryByText("Off.")).toBeNull();
    expect(reads).toBe(3);
  });

  it("is busy and disabled from the click until the answer, and a second click sends no second PUT", async () => {
    const answer = deferred<void>();
    renderSetup("admin", storing(answer.promise));
    const button = await (await shown()).findByRole("button", { name: "Turn on" });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(callsTo(PATH)).toHaveLength(1);
    await act(async () => answer.resolve());
    const turnOff = await (await shown()).findByRole("button", { name: "Turn off" });
    expect(turnOff).toBeEnabled();
    expect(turnOff).not.toHaveAttribute("aria-busy", "true");
  });

  it("asks the shell for /api/me again once after a switched answer", async () => {
    const { refreshMe } = renderSetup("admin", storing());

    await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

    await (await shown()).findByText(ON_WORDS);
    expect(refreshMe).toHaveBeenCalledOnce();
  });

  it("on a 403, says only an Admin turns it on or off, asks /api/me again, and keeps the entry's state", async () => {
    const { refreshMe } = renderSetup("admin", {
      switchCatalogue: () => json(403, { error: "Only an Admin can do this" }),
    });

    await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

    expect(await (await shown()).findByRole("alert")).toHaveTextContent(
      "Only an Admin turns a Catalogue on or off.",
    );
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(entry().getByText("Off.")).toBeInTheDocument();
  });

  it.each([
    [
      "a 400, in the server's words",
      () => json(400, { error: "on: Expected boolean" }),
      "on: Expected boolean",
    ],
    ["a 400 with no words", () => json(400, {}), "Nothing was changed."],
    [
      "a 404, in the server's words",
      () => json(404, { error: "No such Catalogue" }),
      "No such Catalogue",
    ],
    [
      "a 404 with no words",
      () => new Response("Not Found", { status: 404 }),
      "Nothing was changed.",
    ],
    ["a 409", () => json(409, { error: "not opened" }), TEAM_NOT_OPENED],
    [
      "a 429 with Retry-After: 120",
      () => json(429, { error: "too many" }, { "Retry-After": "120" }),
      "Too many sign-in attempts. Try again in 120 seconds.",
    ],
    [
      "no answer",
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
      NOT_ANSWERING,
    ],
    ["a 200 that isn't a Catalogue", () => json(200, { on: true }), NOT_ANSWERING],
  ])(
    "shows %s as an alert, keeps the entry, gives the button back, and clears it at the next click",
    async (_name, refusal, words) => {
      const next = deferred<Response>();
      let answers = 0;
      const { refreshMe } = renderSetup("admin", {
        switchCatalogue: () => (answers++ === 0 ? refusal() : next.promise),
      });

      await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

      expect(await (await shown()).findByRole("alert")).toHaveTextContent(words);
      expect(entry().getByText("Off.")).toBeInTheDocument();
      const button = entry().getByRole("button", { name: "Turn on" });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("aria-busy", "true");
      expect(refreshMe).not.toHaveBeenCalled();

      await userEvent.click(button);

      expect(entry().queryByRole("alert")).toBeNull();
      await act(async () => next.resolve(json(200, catalogueSet(true))));
    },
  );

  // That no PUT goes while /api/me names another Team is vouch.test.ts's (switchCatalogueInTeam); here, what it says.
  it("asks /api/me before the PUT, and on its 429 says so as an alert and sends no PUT", async () => {
    renderSetup("admin", {
      me: () => json(429, { error: "too many" }, { "Retry-After": "30" }),
      switchCatalogue: switched,
    });

    await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

    expect(await (await shown()).findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Try again in 30 seconds.",
    );
    expect(callsTo("/api/me")).toHaveLength(1);
    expect(callsTo(PATH)).toEqual([]);
    expect(entry().getByRole("button", { name: "Turn on" })).toBeEnabled();
  });

  it("ends the session when the switch answers 401", async () => {
    const { onSessionEnded } = renderSetup("admin", {
      switchCatalogue: () => json(401, { error: "signed out" }),
    });

    await userEvent.click(await (await shown()).findByRole("button", { name: "Turn on" }));

    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it.each<Role>(["lead", "member"])(
    "shows a %s the entry and its state, that an Admin turns it on or off, and no button, and sends no PUT",
    async (role) => {
      renderSetup(role, { catalogues: cataloguesOf(catalogueSet(true)) });

      expect(await (await shown()).findByText(ON_WORDS)).toBeInTheDocument();
      expect(entry().getByText("VDA ISA 2027.1, published Sep 30, 2026")).toBeInTheDocument();
      expect(entry().getByText(`Turned on ${dayAndTimeWords(SET_AT)}`)).toBeInTheDocument();
      expect(entry().getByText(ADMIN_DOES)).toHaveClass("muted");
      expect(catalogues().queryByRole("button")).toBeNull();
      expect(callsTo(PATH)).toEqual([]);
    },
  );

  it("shows the credit line and the licence as a link to its page, in a new tab", async () => {
    renderSetup("member");

    const licence = await (await shown()).findByRole("link", { name: "CC BY-ND 4.0" });
    expect(licence).toHaveAttribute("href", "https://creativecommons.org/licenses/by-nd/4.0/");
    expect(licence).toHaveAttribute("target", "_blank");
    expect(licence).toHaveAttribute("rel", "noreferrer");
    expect(entry().getByText(CATALOGUE.credit, { exact: false })).toHaveClass("muted");
  });

  it("never shows who set the Catalogue", async () => {
    renderSetup("admin", { catalogues: cataloguesOf(catalogueSet(true)) });

    await (await shown()).findByText(ON_WORDS);
    expect(document.body.innerHTML).not.toContain(SET_BY);
  });

  /** The other three sections show whatever the Catalogues answer. */
  const othersShow = async () => {
    expect(await repos().findByText("No repos linked yet.")).toBeInTheDocument();
    expect(
      await github().findByRole("link", { name: "Install the GitHub app" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Grant write access" })).getByText(
        "No write access granted.",
      ),
    ).toBeInTheDocument();
  };

  it("shows its waiting line while the other sections answer", async () => {
    renderSetup("admin", { catalogues: () => deferred<Response>().promise });

    await othersShow();
    expect(catalogues().getByText("Loading the Team's Catalogues…")).toHaveClass("muted");
  });

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
  ])(
    "shows the list's refusal, with the other sections there: %s",
    async (_name, answer, words) => {
      renderSetup("admin", { catalogues: answer });

      expect(await catalogues().findByText(words)).toBeInTheDocument();
      await othersShow();
    },
  );

  it("shows the list's not-answering line with Retry, the other sections there, and the Catalogue after Retry", async () => {
    let answer = (): Response => {
      throw new TypeError("Failed to fetch");
    };
    renderSetup("admin", { catalogues: () => answer() });

    expect(await catalogues().findByText("Warden's server isn't answering")).toBeInTheDocument();
    await othersShow();
    answer = cataloguesOf(CATALOGUE);
    await userEvent.click(catalogues().getByRole("button", { name: "Retry" }));

    expect(await (await shown()).findByText("Off.")).toBeInTheDocument();
  });

  it("says there are no Catalogues on this Warden for an empty list", async () => {
    renderSetup("admin", { catalogues: cataloguesOf() });

    expect(await catalogues().findByText("No Catalogues on this Warden.")).toHaveClass("muted");
    await othersShow();
  });

  describe("opened at #setup-catalogues, the Overview's Setup pointer (#383)", () => {
    // jsdom lays nothing out, so it has no scrollIntoView: each test gives Element one, and records what it was called on.
    const scrolled = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();
    beforeEach(() => {
      scrolled.mockReset();
      Element.prototype.scrollIntoView = scrolled;
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it("brings the Catalogues heading into view once the list answers, and only it", async () => {
      window.history.replaceState(null, "", "/setup#setup-catalogues");
      const list = deferred<Response>();
      renderSetup("admin", { catalogues: () => list.promise });

      await vi.waitFor(() => expect(callsTo("/api/vouch/catalogues")).toHaveLength(1));
      expect(scrolled).not.toHaveBeenCalled();
      list.resolve(cataloguesOf(CATALOGUE)());

      await shown();
      await vi.waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
      expect(scrolled.mock.contexts[0]).toBe(
        screen.getByRole("heading", { level: 2, name: "Catalogues" }),
      );
    });

    it.each([
      ["the GitHub app", "githubApp", "/api/github/app"],
      ["the write app", "writeApp", "/api/github/write-app"],
      ["the write grants", "writeGrant", "/api/github/write-grant"],
      ["the Repos", "repos", "/api/repos"],
      ["the agent hook", "hook", "/api/hook"],
    ] as const)(
      "waits for %s, answering after the list, so the heading isn't pushed away",
      async (_section, route, path) => {
        window.history.replaceState(null, "", "/setup#setup-catalogues");
        const late = deferred<Response>();
        renderSetup("admin", { [route]: () => late.promise });

        await shown();
        for (const [other, answered] of Object.entries(ANSWERED_BY)) {
          if (other !== route) await answered();
        }
        expect(callsTo(path)).toHaveLength(1);
        expect(scrolled).not.toHaveBeenCalled();
        late.resolve(SETUP_ROUTES[route]());

        await vi.waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
        expect(scrolled.mock.contexts[0]).toBe(
          screen.getByRole("heading", { level: 2, name: "Catalogues" }),
        );
      },
    );

    it("scrolls nothing at #setup-repos once only the Catalogues have answered", async () => {
      window.history.replaceState(null, "", "/setup#setup-repos");
      renderSetup("admin", { repos: () => deferred<Response>().promise });

      await shown();
      expect(scrolled).not.toHaveBeenCalled();
    });
  });
});

describe("SetupPage: Judge's model (spec #225, slice 6b)", () => {
  // jsdom lays nothing out, so it has no scrollIntoView: each test gives Element one, and records what it was called on.
  const scrolled = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>();
  beforeEach(() => {
    scrolled.mockReset();
    Element.prototype.scrollIntoView = scrolled;
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it.each([
    ["#setup-judge-model", "Judge's model"],
    ["#setup-repos", "Repos"],
  ] as const)(
    "opened at %s, brings the %s heading into view only once the Judge's model has answered too (#464)",
    async (anchor, heading) => {
      window.history.replaceState(null, "", `/setup${anchor}`);
      const late = deferred<Response>();
      renderSetup("admin", { judgeModel: () => late.promise });

      await within(screen.getByRole("region", { name: "Catalogues" })).findByRole("listitem");
      for (const [other, answered] of Object.entries(ANSWERED_BY)) {
        if (other !== "judgeModel") await answered();
      }
      expect(callsTo("/api/judge/model")).toHaveLength(1);
      expect(scrolled).not.toHaveBeenCalled();
      late.resolve(SETUP_ROUTES.judgeModel());

      await vi.waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
      expect(scrolled.mock.contexts[0]).toBe(
        screen.getByRole("heading", { level: 2, name: heading }),
      );
    },
  );
});

describe("SetupPage: Agent hook (story 7)", () => {
  const hook = () => within(screen.getByRole("region", { name: "Agent hook" }));
  const TOKEN = "org_a.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ONCE = "Shown this once. Copy it now: Warden keeps only its hash.";
  const COPIED = "Copied.";
  const CANT_COPY = "Couldn't copy. Select the text and copy it.";
  const ADMIN_DOES = "An Admin turns on the agent hook.";
  /** `POST /api/hook/token`'s 201: the token, in the block too. */
  const issued = (previousUntil: string | null = null, token = TOKEN) =>
    json(201, {
      token,
      issued_at: ISSUED_AT,
      previous_valid_until: previousUntil,
      managed_settings: hookBlock("details", token),
    });
  /** `PUT /api/hook/privacy-tier`'s answer for the body's tier, the block with the placeholder as every read has. */
  const tierSet = (issuedAt: string | null) => (body: unknown) =>
    json(
      200,
      hookSettings({ issuedAt, tier: (body as { privacy_tier: PrivacyTier }).privacy_tier }),
    );
  const block = () =>
    JSON.parse(hook().getByLabelText("Managed-settings block").textContent) as ReturnType<
      typeof hookBlock
    >;
  const authorizations = () =>
    Object.values(block().hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((one) => one.headers.Authorization)),
    );
  const picker = () => hook().getByRole("combobox", { name: "Privacy tier" });
  const tokenPosts = () => callsTo("/api/hook/token");

  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  beforeEach(() => {
    writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    delete (navigator as Partial<Navigator> & { clipboard?: unknown }).clipboard;
  });

  it("shows an Admin the waiting line, then no token yet, Issue, the tier picker at Details and the block", async () => {
    const answer = deferred<Response>();
    renderSetup("admin", { hook: () => answer.promise });

    expect(hook().getByText("Asking Warden's server about the agent hook…")).toBeInTheDocument();
    answer.resolve(noHookToken());

    expect(await hook().findByText("No hook token yet.")).toBeInTheDocument();
    expect(hook().getByRole("button", { name: "Issue a hook token" })).toHaveClass("primary");
    expect(picker()).toHaveValue("details");
    // The options are the tiers' names, short enough for a phone's closed picker (#422); what each sends is listed
    // under it, and describes the picker.
    expect(
      within(picker())
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Metadata", "Details", "Content"]);
    const tierWords = [
      "Metadata: tool names and outcomes",
      "Details: adds commands, file paths and URLs",
      "Content: adds tool output and prompts",
    ];
    expect(
      within(hook().getByRole("list", { name: "What each Privacy tier sends" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(tierWords);
    expect(picker()).toHaveAccessibleDescription(tierWords.join(" "));
    expect(
      hook().getByText("Moving to or from Content changes the block: paste it again."),
    ).toBeInTheDocument();
    expect(block()).toEqual(hookBlock("details"));
    expect(hook().getByLabelText("Managed-settings block").textContent).toBe(
      JSON.stringify(hookBlock("details"), null, 2),
    );
    expect(hook().getByRole("button", { name: "Copy block" })).toBeInTheDocument();
  });

  it("with a token, says when it was issued, until when the one before works, and offers Rotate", async () => {
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT, previousUntil: PREVIOUS_UNTIL })),
    });

    expect(
      await hook().findByText(`Hook token issued ${dayAndTimeWords(ISSUED_AT)}`),
    ).toBeInTheDocument();
    expect(
      hook().getByText(`The token before it works until ${dayAndTimeWords(PREVIOUS_UNTIL)}.`),
    ).toBeInTheDocument();
    expect(hook().getByRole("button", { name: "Rotate the hook token" })).toBeInTheDocument();
    expect(hook().queryByText("No hook token yet.")).toBeNull();
  });

  it("issues once per click, busy until the answer, then shows the token once in mono with the block holding it", async () => {
    const answer = deferred<Response>();
    renderSetup("admin", { issueHookToken: () => answer.promise });
    const issue = await hook().findByRole("button", { name: "Issue a hook token" });

    await userEvent.dblClick(issue);

    await vi.waitFor(() => expect(tokenPosts()).toHaveLength(1));
    expect(issue).toBeDisabled();
    expect(issue).toHaveAttribute("aria-busy", "true");
    await act(async () => answer.resolve(issued()));

    const shownToken = await hook().findByText(TOKEN);
    expect(shownToken.tagName).toBe("CODE");
    expect(hook().getByText(ONCE)).toBeInTheDocument();
    expect(hook().getByRole("button", { name: "Copy token" })).toHaveFocus();
    expect(hook().getByText(`Hook token issued ${dayAndTimeWords(ISSUED_AT)}`)).toBeInTheDocument();
    expect(hook().getByRole("button", { name: "Rotate the hook token" })).toBeEnabled();
    expect(authorizations().every((header) => header === `Bearer ${TOKEN}`)).toBe(true);
    expect(tokenPosts()).toHaveLength(1);
  });

  it("asks before a second rotation while the token before still works: Cancel sends nothing, Rotate again one POST", async () => {
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT, previousUntil: PREVIOUS_UNTIL })),
      issueHookToken: () => issued(PREVIOUS_UNTIL),
    });
    const rotate = await hook().findByRole("button", { name: "Rotate the hook token" });

    await userEvent.click(rotate);
    const confirm = hook().getByRole("group", {
      name: `The token before the current one still works until ${dayAndTimeWords(PREVIOUS_UNTIL)}. Rotating again stops it at once: laptops that haven't got the current token stop sending.`,
    });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(hook().queryByRole("group")).toBeNull();
    expect(rotate).toHaveFocus();
    expect(tokenPosts()).toHaveLength(0);

    await userEvent.click(rotate);
    await userEvent.keyboard("{Escape}");
    expect(hook().queryByRole("group")).toBeNull();
    expect(tokenPosts()).toHaveLength(0);

    await userEvent.click(rotate);
    const again = within(hook().getByRole("group")).getByRole("button", { name: "Rotate again" });
    expect(again).toHaveClass("primary");
    await userEvent.dblClick(again);

    expect(await hook().findByText(TOKEN)).toBeInTheDocument();
    expect(tokenPosts()).toHaveLength(1);
    expect(hook().queryByRole("group")).toBeNull();
  });

  it("rotates with no confirm while no token before the current one works", async () => {
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT })),
      issueHookToken: () => issued(PREVIOUS_UNTIL),
    });

    await userEvent.click(await hook().findByRole("button", { name: "Rotate the hook token" }));

    expect(await hook().findByText(TOKEN)).toBeInTheDocument();
    expect(hook().queryByRole("group")).toBeNull();
    expect(tokenPosts()).toHaveLength(1);
    expect(
      hook().getByText(`The token before it works until ${dayAndTimeWords(PREVIOUS_UNTIL)}.`),
    ).toBeInTheDocument();
  });

  it("copies the token and the block through the clipboard, saying Copied.", async () => {
    renderSetup("admin", { issueHookToken: () => issued() });
    await userEvent.click(await hook().findByRole("button", { name: "Issue a hook token" }));

    await userEvent.click(await hook().findByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenLastCalledWith(TOKEN);
    expect(await hook().findByText(COPIED)).toBeInTheDocument();

    await userEvent.click(hook().getByRole("button", { name: "Copy block" }));
    expect(writeText).toHaveBeenLastCalledWith(
      JSON.stringify(hookBlock("details", TOKEN), null, 2),
    );
    expect(await hook().findAllByText(COPIED)).toHaveLength(1);
  });

  it("says it couldn't copy when the clipboard refuses, or there is none", async () => {
    writeText.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    renderSetup("admin");

    await userEvent.click(await hook().findByRole("button", { name: "Copy block" }));
    expect(await hook().findByText(CANT_COPY)).toBeInTheDocument();

    delete (navigator as Partial<Navigator> & { clipboard?: unknown }).clipboard;
    await userEvent.click(hook().getByRole("button", { name: "Copy block" }));
    expect(await hook().findByText(CANT_COPY)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("sends Content's tier, disabled and busy until the answer, and the block then has UserPromptSubmit", async () => {
    const answer = deferred<void>();
    renderSetup("admin", {
      setPrivacyTier: async (body) => {
        await answer.promise;
        return tierSet(null)(body);
      },
    });
    await hook().findByText("No hook token yet.");

    await userEvent.selectOptions(picker(), "content");

    await vi.waitFor(() => expect(callsTo("/api/hook/privacy-tier")).toHaveLength(1));
    expect(picker()).toBeDisabled();
    expect(picker()).toHaveAttribute("aria-busy", "true");
    expect(JSON.parse(String(callsTo("/api/hook/privacy-tier")[0]?.[1]?.body))).toEqual({
      privacy_tier: "content",
    });
    await act(async () => answer.resolve());

    await vi.waitFor(() => expect(picker()).toBeEnabled());
    expect(picker()).toHaveValue("content");
    expect(block().hooks).toHaveProperty("UserPromptSubmit");
  });

  it("keeps the token it just issued in the block's Authorization header after a tier change", async () => {
    renderSetup("admin", { issueHookToken: () => issued(), setPrivacyTier: tierSet(ISSUED_AT) });
    await userEvent.click(await hook().findByRole("button", { name: "Issue a hook token" }));
    await hook().findByText(TOKEN);

    await userEvent.selectOptions(picker(), "content");

    await vi.waitFor(() => expect(block().hooks).toHaveProperty("UserPromptSubmit"));
    expect(authorizations()).toHaveLength(4);
    expect(authorizations().every((header) => header === `Bearer ${TOKEN}`)).toBe(true);
  });

  it.each([
    ["a 400", () => json(400, { error: "privacy_tier must be one of metadata, details, content" })],
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("on %s for the tier, puts the picker back and says so", async (_case, answer) => {
    renderSetup("admin", { setPrivacyTier: answer });
    await hook().findByText("No hook token yet.");

    await userEvent.selectOptions(picker(), "content");

    expect(await hook().findByRole("alert")).toBeInTheDocument();
    expect(picker()).toHaveValue("details");
    expect(picker()).toBeEnabled();
    expect(block()).toEqual(hookBlock("details"));
  });

  it("on a refused POST, shows no token and an alert, leaves the settings, and issues again on the next click", async () => {
    let posts = 0;
    renderSetup("admin", {
      issueHookToken: () => (++posts === 1 ? json(500, { error: "Internal error" }) : issued()),
    });
    const issue = await hook().findByRole("button", { name: "Issue a hook token" });

    await userEvent.click(issue);

    expect(await hook().findByRole("alert")).toBeInTheDocument();
    expect(hook().queryByText(ONCE)).toBeNull();
    expect(hook().getByText("No hook token yet.")).toBeInTheDocument();
    expect(block()).toEqual(hookBlock("details"));
    expect(issue).toBeEnabled();

    await userEvent.click(issue);
    expect(await hook().findByText(TOKEN)).toBeInTheDocument();
    expect(hook().queryByRole("alert")).toBeNull();
    expect(tokenPosts()).toHaveLength(2);
  });

  it("on a 403 for the settings, says an Admin turns it on and asks /api/me again once", async () => {
    const { refreshMe } = renderSetup("admin", {
      hook: () => json(403, { error: "Only an Admin can do this" }),
    });

    expect(await hook().findByText(ADMIN_DOES)).toHaveClass("muted");
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledOnce());
    expect(hook().queryByRole("button")).toBeNull();
  });

  it.each([
    ["issuing", { issueHookToken: () => json(403, { error: "Only an Admin can do this" }) }],
    ["the tier", { setPrivacyTier: () => json(403, { error: "Only an Admin can do this" }) }],
  ] as const)("on a 403 for %s, says so and asks /api/me again", async (what, routes) => {
    const { refreshMe } = renderSetup("admin", routes);
    await hook().findByText("No hook token yet.");

    if (what === "issuing") {
      await userEvent.click(hook().getByRole("button", { name: "Issue a hook token" }));
    } else {
      await userEvent.selectOptions(picker(), "metadata");
    }

    expect(await hook().findByRole("alert")).toHaveTextContent("Only an Admin");
    expect(refreshMe).toHaveBeenCalledOnce();
  });

  it("on no answer for the settings, offers Retry, and on a 409 says the Team isn't opened", async () => {
    let reads = 0;
    renderSetup("admin", {
      hook: () =>
        ++reads === 1 ? Promise.reject(new TypeError("Failed to fetch")) : json(409, {}),
    });

    await userEvent.click(await hook().findByRole("button", { name: "Retry" }));

    expect(await hook().findByText(TEAM_NOT_OPENED)).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it.each(["lead", "member"] as const)(
    "tells a %s an Admin turns it on, and asks nothing about the hook",
    async (role) => {
      renderSetup(role);

      expect(hook().getByText(ADMIN_DOES)).toHaveClass("muted");
      await repos().findByText("No repos linked yet.");
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/hook")),
      ).toEqual([]);
    },
  );

  it("holds the token only on the page: never in storage or the address", async () => {
    renderSetup("admin", { issueHookToken: () => issued() });
    await userEvent.click(await hook().findByRole("button", { name: "Issue a hook token" }));
    await hook().findByText(TOKEN);

    const stored = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i) ?? "";
        return `${key}=${storage.getItem(key) ?? ""}`;
      }).join("\n");
    expect(stored(localStorage)).not.toContain(TOKEN);
    expect(stored(sessionStorage)).not.toContain(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });

  it("asks /api/me again on each later 403, after a section's 403 has already asked once", async () => {
    const { refreshMe } = renderSetup("admin", {
      githubApp: () => json(403, { error: "Only an Admin can do this" }),
      issueHookToken: () => json(403, { error: "Only an Admin can do this" }),
    });
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledOnce());
    const issue = await hook().findByRole("button", { name: "Issue a hook token" });

    await userEvent.click(issue);
    await hook().findByRole("alert");
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(2));
    await userEvent.click(issue);
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(3));
  });

  it("keeps the tier picker still while the confirm is open, so Rotate is never left disabled with no Cancel", async () => {
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT, previousUntil: PREVIOUS_UNTIL })),
    });
    const rotate = await hook().findByRole("button", { name: "Rotate the hook token" });

    await userEvent.click(rotate);
    expect(picker()).toBeDisabled();
    await userEvent.click(hook().getByRole("button", { name: "Cancel" }));

    expect(picker()).toBeEnabled();
    expect(rotate).toBeEnabled();
  });

  it("reads the settings again after a failed rotation, so a second rotation still asks first", async () => {
    let reads = 0;
    renderSetup("admin", {
      // Another Admin rotated while this page was open: the second read has a token before the current one.
      hook: () =>
        json(
          200,
          hookSettings({
            issuedAt: ISSUED_AT,
            previousUntil: ++reads === 1 ? null : PREVIOUS_UNTIL,
          }),
        ),
      issueHookToken: () => json(500, { error: "Internal error" }),
    });
    const rotate = await hook().findByRole("button", { name: "Rotate the hook token" });

    await userEvent.click(rotate);
    await hook().findByRole("alert");
    await vi.waitFor(() => expect(callsTo("/api/hook")).toHaveLength(2));
    await hook().findByText(`The token before it works until ${dayAndTimeWords(PREVIOUS_UNTIL)}.`);
    await userEvent.click(rotate);

    expect(hook().getByRole("group")).toBeInTheDocument();
    expect(tokenPosts()).toHaveLength(1);
  });

  it("puts the held token in the block only while the settings describe that token", async () => {
    const NEWER = "2026-11-26T11:00:00.000Z";
    renderSetup("admin", { issueHookToken: () => issued(), setPrivacyTier: tierSet(NEWER) });
    await userEvent.click(await hook().findByRole("button", { name: "Issue a hook token" }));
    await hook().findByText(TOKEN);

    // The PUT's answer describes a token another Admin issued since.
    await userEvent.selectOptions(picker(), "content");

    await vi.waitFor(() => expect(block().hooks).toHaveProperty("UserPromptSubmit"));
    expect(authorizations().every((header) => header === `Bearer ${HOOK_TOKEN_PLACEHOLDER}`)).toBe(
      true,
    );
  });

  it("keeps Rotate and the tier picker from running at once", async () => {
    const post = deferred<Response>();
    const put = deferred<Response>();
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT })),
      issueHookToken: () => post.promise,
      setPrivacyTier: () => put.promise,
    });
    const rotate = await hook().findByRole("button", { name: "Rotate the hook token" });

    await userEvent.click(rotate);
    await vi.waitFor(() => expect(tokenPosts()).toHaveLength(1));
    expect(picker()).toBeDisabled();
    await act(async () => post.resolve(issued()));
    await hook().findByText(TOKEN);

    await userEvent.selectOptions(picker(), "content");
    await vi.waitFor(() => expect(callsTo("/api/hook/privacy-tier")).toHaveLength(1));
    expect(rotate).toBeDisabled();
    await act(async () => put.resolve(tierSet(ISSUED_AT)({ privacy_tier: "content" })));
    await vi.waitFor(() => expect(rotate).toBeEnabled());
  });

  it("drops Copied. once a tier change changes the block", async () => {
    renderSetup("admin", { setPrivacyTier: tierSet(null) });
    await userEvent.click(await hook().findByRole("button", { name: "Copy block" }));
    expect(await hook().findByText(COPIED)).toBeInTheDocument();

    await userEvent.selectOptions(picker(), "content");

    await vi.waitFor(() => expect(block().hooks).toHaveProperty("UserPromptSubmit"));
    expect(hook().queryByText(COPIED)).toBeNull();
  });

  it("on a refused Rotate again, puts focus on Rotate", async () => {
    renderSetup("admin", {
      hook: () => json(200, hookSettings({ issuedAt: ISSUED_AT, previousUntil: PREVIOUS_UNTIL })),
      issueHookToken: () => json(500, { error: "Internal error" }),
    });
    const rotate = await hook().findByRole("button", { name: "Rotate the hook token" });
    await userEvent.click(rotate);

    await userEvent.click(hook().getByRole("button", { name: "Rotate again" }));

    await hook().findByRole("alert");
    await vi.waitFor(() => expect(rotate).toHaveFocus());
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
