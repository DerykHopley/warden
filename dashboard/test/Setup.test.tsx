// The Setup page and GitHub's Setup URL (`/setup/github`), story 1: an Admin's install link, the Team's Repo Assets,
// and the sign-in button for the installation GitHub names. Each page renders alone with spy props over the fake API.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@warden/contracts";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPT_KEY } from "../src/github-setup.ts";
import { goTo } from "../src/navigate.ts";
import { GitHubSetupPage, SetupPage } from "../src/Setup.tsx";
import { callsTo, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));
vi.mock("../src/navigate.ts", () => ({ goTo: vi.fn() }));

const INSTALL_URL = "https://github.com/apps/warden-reader/installations/new";
const app = () => json(200, { slug: "warden-reader", client_id: "Iv23li-client" });
const repo = (name: string) => ({
  asset: { kind: "repo", ref: `https://github.com/acme/${name}` },
  installation_id: 42,
  listed_at: "2026-11-25T09:00:00.000Z",
});

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

function renderSetup(role: Role, routes: Routes = {}) {
  serve({ githubApp: app, repos: () => json(200, { repos: [] }), ...routes });
  render(<SetupPage {...props(role)} />);
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

  it("lists the Team's Repo Assets by ref", async () => {
    renderSetup("member", {
      repos: () => json(200, { repos: [repo("web"), repo("api")] }),
    });

    const list = await repos().findByRole("list");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["https://github.com/acme/web", "https://github.com/acme/api"]);
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
    });
    const refreshMe = vi.fn();
    // The shell's refreshMe changes the shell's state, as AppShell's does.
    function Shell() {
      const [, setAsked] = useState(0);
      const refresh = useCallback(() => {
        refreshMe();
        setAsked((n) => n + 1);
      }, []);
      return <SetupPage {...props("admin")} refreshMe={refresh} />;
    }
    render(<Shell />);

    expect(await github().findByText("An Admin connects GitHub.")).toBeInTheDocument();
    // refreshMe runs in an effect after the render that shows the text, so a busy runner can see the text first.
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledOnce());
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
