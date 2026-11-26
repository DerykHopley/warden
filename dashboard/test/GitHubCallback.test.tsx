// GitHub's callback URL (`/setup/github/callback`), story 1: the kept sign-in attempt, checked against GitHub's
// `state`, becomes one link call, whatever React does with the page's effects; each answer reads as written in
// docs/design.md, and a sign-in that didn't start here sends nothing.
import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPT_KEY, WRITE_ATTEMPT_KEY, type SignInAttempt } from "../src/github-setup.ts";
import { GitHubCallbackPage, WriteAppCallbackPage } from "../src/GitHubCallback.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

const VERIFIER = "v".repeat(43);
const ATTEMPT: SignInAttempt = { state: "the-state", verifier: VERIFIER, installationId: 42 };
const repo = (name: string) => ({
  asset: { kind: "repo", ref: `https://github.com/acme/${name}` },
  installation_id: 42,
  listed_at: "2026-11-25T09:00:00.000Z",
});
const linked = (count: number) => () =>
  json(201, {
    installation_id: 42,
    repos: ["web", "api"].slice(0, count).map(repo),
    scan: null,
  });

beforeEach(() => {
  resetClerk();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const keep = (attempt: SignInAttempt = ATTEMPT) =>
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
const WRITE_CALLBACK = "/setup/github/write/callback";
const keepWrite = (attempt: SignInAttempt = ATTEMPT) =>
  sessionStorage.setItem(WRITE_ATTEMPT_KEY, JSON.stringify(attempt));

/** Opens the callback at `search` (null: the address as it is), and renders the page over the fake API. */
function renderCallback(search: string | null, routes: Routes = {}, { strict = false } = {}) {
  if (search !== null) window.history.replaceState(null, "", `/setup/github/callback${search}`);
  serve({ linkInstallation: linked(2), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role: "admin" as const, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
  const page = <GitHubCallbackPage {...props} />;
  const { unmount } = render(strict ? <StrictMode>{page}</StrictMode> : page);
  return { ...props, unmount };
}

const address = () => location.pathname + location.search;

const links = () => callsTo("/api/github/installations");
const grants = () => callsTo("/api/github/write-installations");
const backToSetup = () => screen.getByRole("link", { name: "Back to Setup" });

describe("GitHubCallbackPage", () => {
  it("links the kept installation with GitHub's code and the kept verifier, and says how many repos", async () => {
    keep();
    renderCallback("?code=the-code&state=the-state");

    expect(await screen.findByText("Linked installation 42: 2 repos.")).toBeInTheDocument();
    expect(backToSetup()).toHaveAttribute("href", "/setup");
    expect(links()).toHaveLength(1);
    expect(JSON.parse(String(links()[0]![1]!.body))).toEqual({
      installation_id: 42,
      code: "the-code",
      code_verifier: VERIFIER,
    });
  });

  it("says 1 repo in the singular", async () => {
    keep();
    renderCallback("?code=the-code&state=the-state", { linkInstallation: linked(1) });

    expect(await screen.findByText("Linked installation 42: 1 repo.")).toBeInTheDocument();
  });

  it("sends one POST under StrictMode, and the kept attempt is gone after it", async () => {
    keep();
    const answer = deferred<Response>();
    renderCallback(
      "?code=the-code&state=the-state",
      { linkInstallation: () => answer.promise },
      { strict: true },
    );

    await vi.waitFor(() => expect(links()).toHaveLength(1));
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
    answer.resolve(linked(2)());
    expect(await screen.findByText("Linked installation 42: 2 repos.")).toBeInTheDocument();
    expect(links()).toHaveLength(1);
  });

  it.each([
    ["no kept attempt", "?code=the-code&state=the-state", false],
    ["no code", "?state=the-state", true],
    ["no state", "?code=the-code", true],
    ["a state that doesn't match", "?code=the-code&state=another-state", true],
  ])(
    "with %s, says the sign-in didn't start here and sends nothing",
    async (_name, search, kept) => {
      if (kept) keep();
      renderCallback(search);

      expect(
        await screen.findByText("This GitHub sign-in didn't start here. Connect again from Setup."),
      ).toBeInTheDocument();
      expect(backToSetup()).toHaveAttribute("href", "/setup");
      expect(links()).toEqual([]);
    },
  );

  it("says the person cancelled when GitHub answers access_denied, and sends nothing", async () => {
    keep();
    renderCallback("?error=access_denied&state=the-state");

    expect(
      await screen.findByText("You cancelled the GitHub sign-in; nothing was linked."),
    ).toBeInTheDocument();
    expect(backToSetup()).toHaveAttribute("href", "/setup");
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
    expect(links()).toEqual([]);
  });

  it.each([
    [
      "a GitHub error code",
      "?error=redirect_uri_mismatch&error_description=The+redirect_uri+MUST+match&state=the-state",
      "GitHub refused the sign-in (redirect_uri_mismatch); nothing was linked.",
    ],
    [
      "an error that isn't one of GitHub's codes",
      "?error=Call+0800+to+fix+your+account&state=the-state",
      "GitHub refused the sign-in; nothing was linked.",
    ],
  ])(
    "with %s other than access_denied, names it in an alert and sends nothing",
    async (_name, search, words) => {
      keep();
      renderCallback(search);

      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      expect(backToSetup()).toHaveAttribute("href", "/setup");
      expect(links()).toEqual([]);
    },
  );

  it("takes GitHub's code and state out of the address bar, leaving no history entry with them", async () => {
    keep();
    const before = history.length;
    renderCallback("?code=the-code&state=the-state");

    expect(address()).toBe("/setup/github/callback");
    await screen.findByText("Linked installation 42: 2 repos.");
    expect(history.length).toBe(before);
  });

  it("when the session has ended, keeps the attempt and GitHub's answer, so the page links once the person signs in again", async () => {
    keep();
    const first = renderCallback("?code=the-code&state=the-state", {
      linkInstallation: () => json(401, { error: "Session ended" }),
    });
    await vi.waitFor(() => expect(first.onSessionEnded).toHaveBeenCalledOnce());
    expect(JSON.parse(sessionStorage.getItem(ATTEMPT_KEY)!)).toEqual(ATTEMPT);
    expect(address()).toBe("/setup/github/callback?code=the-code&state=the-state");
    first.unmount();

    renderCallback(null);

    expect(await screen.findByText("Linked installation 42: 2 repos.")).toBeInTheDocument();
    expect(links()).toHaveLength(2);
  });

  it("a page mounted again while the link call runs waits on that call, and sends no second one", async () => {
    keep();
    const answer = deferred<Response>();
    const first = renderCallback("?code=the-code&state=the-state", {
      linkInstallation: () => answer.promise,
    });
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    first.unmount();

    renderCallback(null, { linkInstallation: () => answer.promise });
    answer.resolve(linked(2)());

    expect(await screen.findByText("Linked installation 42: 2 repos.")).toBeInTheDocument();
    expect(links()).toHaveLength(1);
  });

  it.each([400, 403, 409, 502, 503])(
    "shows a %s in the server's words, as an alert, with a link back to Setup",
    async (status) => {
      keep();
      renderCallback("?code=the-code&state=the-state", {
        linkInstallation: () =>
          json(status, { error: "This installation is linked to another Team" }),
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This installation is linked to another Team",
      );
      expect(backToSetup()).toHaveAttribute("href", "/setup");
    },
  );

  it.each([
    ["Retry-After: 120", { "Retry-After": "120" }, "Too many tries: try again in 2 min"],
    ["no Retry-After", {}, "Too many tries: try again later"],
  ])("words a 429 with %s", async (_name, headers, words) => {
    keep();
    renderCallback("?code=the-code&state=the-state", {
      linkInstallation: () =>
        json(429, { error: "A Team links at most 10 times an hour" }, headers),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(backToSetup()).toBeInTheDocument();
  });

  it("on no answer, says the link may have been made, with a link to Setup and no Retry", async () => {
    keep();
    renderCallback("?code=the-code&state=the-state", {
      linkInstallation: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    expect(
      await screen.findByText("Warden didn't answer; the link may not have been made."),
    ).toBeInTheDocument();
    expect(backToSetup()).toHaveAttribute("href", "/setup");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ends the session when the server says it has", async () => {
    keep();
    const props = renderCallback("?code=the-code&state=the-state", {
      linkInstallation: () => json(401, { error: "Session ended" }),
    });

    await vi.waitFor(() => expect(props.onSessionEnded).toHaveBeenCalledOnce());
  });

  it("with the write app's attempt kept, says the sign-in didn't start here and sends nothing", async () => {
    keepWrite();
    renderCallback("?code=the-code&state=the-state");

    expect(
      await screen.findByText("This GitHub sign-in didn't start here. Connect again from Setup."),
    ).toBeInTheDocument();
    expect(links()).toEqual([]);
    expect(grants()).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(WRITE_ATTEMPT_KEY)!)).toEqual(ATTEMPT);
  });
});

const granted = (status: 200 | 201) => () =>
  json(status, {
    installation_id: 42,
    granted_by: "user_1",
    granted_at: "2026-11-26T09:14:00.000Z",
  });

/** Opens the write app's callback at `search` (null: the address as it is), over the fake API. */
function renderWriteCallback(search: string | null, routes: Routes = {}) {
  if (search !== null) window.history.replaceState(null, "", `${WRITE_CALLBACK}${search}`);
  serve({ grantWrite: granted(201), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role: "admin" as const, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn() },
  };
  const { unmount } = render(<WriteAppCallbackPage {...props} />);
  return { ...props, unmount };
}

const GRANTED = "Write access granted through installation 42.";
/** The write callback's own words for a sign-in that didn't start here (#224, story 16). */
const NOT_STARTED_HERE =
  "This GitHub sign-in didn't start here. Grant write access again from Setup.";

describe("WriteAppCallbackPage (#224, story 5)", () => {
  it.each([201, 200] as const)(
    "on a %s, grants write access through the kept installation, posting once, with no query left",
    async (status) => {
      keepWrite();
      renderWriteCallback("?code=the-code&state=the-state", { grantWrite: granted(status) });

      expect(
        screen.getByRole("heading", { level: 1, name: "Grant write access" }),
      ).toBeInTheDocument();
      expect(await screen.findByText(GRANTED)).toBeInTheDocument();
      expect(backToSetup()).toHaveAttribute("href", "/setup");
      expect(address()).toBe(WRITE_CALLBACK);
      expect(grants()).toHaveLength(1);
      expect(JSON.parse(String(grants()[0]![1]!.body))).toEqual({
        installation_id: 42,
        code: "the-code",
        code_verifier: VERIFIER,
      });
      expect(links()).toEqual([]);
    },
  );

  it.each([
    [409, "This installation's permissions aren't the write app's"],
    [403, "You need admin on every repo this installation reaches to grant write access"],
  ])("shows a %s in the server's words, as an alert", async (status, words) => {
    keepWrite();
    renderWriteCallback("?code=the-code&state=the-state", {
      grantWrite: () => json(status, { error: words }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(backToSetup()).toHaveAttribute("href", "/setup");
  });

  it.each([
    [
      "too many tries",
      "?code=the-code&state=the-state",
      () => json(429, { error: "too many" }, { "Retry-After": "120" }),
      "Too many tries: try again in 2 min",
    ],
    [
      "no answer",
      "?code=the-code&state=the-state",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Warden didn't answer; write access may not have been granted.",
    ],
    [
      "cancelled on GitHub",
      "?error=access_denied&state=the-state",
      granted(201),
      "You cancelled the GitHub sign-in; nothing was granted.",
    ],
    [
      "another GitHub error",
      "?error=redirect_uri_mismatch&state=the-state",
      granted(201),
      "GitHub refused the sign-in (redirect_uri_mismatch); nothing was granted.",
    ],
  ])(
    "words %s as the read callback does, with granted for linked",
    async (_name, search, answer, words) => {
      keepWrite();
      renderWriteCallback(search, { grantWrite: answer });

      expect(await screen.findByText(words)).toBeInTheDocument();
      expect(backToSetup()).toHaveAttribute("href", "/setup");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    },
  );

  it.each([
    ["no kept attempt", "?code=the-code&state=the-state", false],
    ["no code", "?state=the-state", true],
    ["no state", "?code=the-code", true],
    ["a state that doesn't match", "?code=the-code&state=another-state", true],
  ])(
    "with %s, says the sign-in didn't start here in its own words and sends nothing",
    async (_name, search, kept) => {
      if (kept) keepWrite();
      renderWriteCallback(search);

      expect(await screen.findByRole("alert")).toHaveTextContent(NOT_STARTED_HERE);
      expect(backToSetup()).toHaveAttribute("href", "/setup");
      expect(grants()).toEqual([]);
    },
  );

  it("with the read app's attempt kept, says the sign-in didn't start here and sends nothing", async () => {
    keep();
    renderWriteCallback("?code=the-code&state=the-state");

    expect(await screen.findByText(NOT_STARTED_HERE)).toBeInTheDocument();
    expect(grants()).toEqual([]);
    expect(links()).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(ATTEMPT_KEY)!)).toEqual(ATTEMPT);
  });

  it("when the session has ended, keeps the attempt and GitHub's answer, and grants once the person signs in again", async () => {
    keepWrite();
    const first = renderWriteCallback("?code=the-code&state=the-state", {
      grantWrite: () => json(401, { error: "Session ended" }),
    });
    await vi.waitFor(() => expect(first.onSessionEnded).toHaveBeenCalledOnce());
    expect(JSON.parse(sessionStorage.getItem(WRITE_ATTEMPT_KEY)!)).toEqual(ATTEMPT);
    expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
    expect(address()).toBe(`${WRITE_CALLBACK}?code=the-code&state=the-state`);
    first.unmount();

    renderWriteCallback(null);

    expect(await screen.findByText(GRANTED)).toBeInTheDocument();
    expect(grants()).toHaveLength(2);
  });
});
