// The dashboard's sign-in states, with Clerk's React hooks stubbed and Warden's server faked.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { callsTo, fetchMock, json, serve } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

beforeEach(() => {
  resetClerk();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function signIn(sessionId = "sess_1", orgId: string | null = "org_1") {
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = sessionId;
  clerk.auth.orgId = orgId;
  clerk.orgNames = { org_1: "Acme" };
}

function signOut() {
  clerk.auth.isSignedIn = false;
  clerk.auth.sessionId = null;
  clerk.auth.orgId = null;
}

const header = () => within(screen.getByRole("banner"));

describe("while Clerk loads", () => {
  const NOTICE = "Sign-in couldn't load. An ad blocker or a lost connection can stop it.";

  beforeEach(() => {
    vi.useFakeTimers();
    clerk.auth.isLoaded = false;
    clerk.status = "loading";
  });
  afterEach(() => vi.useRealTimers());

  it("shows Loading… for 10 seconds, then the notice with Try again, which reloads the page", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<App />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalled();
  });

  it("shows the notice at once when Clerk reports that it failed to load", () => {
    clerk.status = "error";
    render(<App />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the app, not the notice, once Clerk loads in time", () => {
    const { rerender } = render(<App />);
    act(() => vi.advanceTimersByTime(5_000));
    clerk.auth.isLoaded = true;
    clerk.status = "ready";
    rerender(<App />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

describe("App", () => {
  it("shows Clerk's sign-in when signed out", () => {
    render(<App />);
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the server who the person is with their session token, and signs out from the header", async () => {
    signIn();
    serve({
      me: () => json(200, { userId: "user_1", team: "org_1", role: "admin" }),
      findings: () => json(200, { team: "org_1", findings: [] }),
    });
    render(<App />);

    expect(await header().findByText("Admin")).toBeInTheDocument();
    expect(callsTo("/api/me")[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer session-token" },
    });

    await userEvent.click(header().getByRole("button", { name: "Sign out" }));
    expect(clerk.auth.signOut).toHaveBeenCalled();
  });

  it("on a 401, signs the person out, then shows the session-ended message with the sign-in", async () => {
    signIn();
    serve({ me: () => json(401, { error: "Not signed in" }) });
    const { rerender } = render(<App />);

    // While Clerk still holds the session, the sign-in doesn't mount.
    expect(await screen.findByText("Signing you out…")).toBeInTheDocument();
    expect(screen.queryByText("Clerk sign-in")).not.toBeInTheDocument();
    expect(clerk.auth.signOut).toHaveBeenCalled();

    signOut();
    rerender(<App />);

    expect(screen.getByText("Your session has ended: sign in again")).toBeInTheDocument();
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
  });

  it("forgets the ended session once a new one signs in", async () => {
    signIn();
    serve({ me: () => json(401, { error: "Not signed in" }) });
    const { rerender } = render(<App />);
    await screen.findByText("Signing you out…");
    signOut();
    rerender(<App />);

    serve({ me: () => json(200, { userId: "user_again", team: null, role: null }) });
    signIn("sess_2", null);
    rerender(<App />);
    expect(
      await screen.findByText("Create a Team, or choose one you've been invited to"),
    ).toBeInTheDocument();

    signOut();
    rerender(<App />);
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(screen.queryByText("Your session has ended: sign in again")).not.toBeInTheDocument();
  });

  it("shows the not-answering message when Clerk can't give a token", async () => {
    signIn();
    clerk.auth.getToken = () => Promise.reject(new Error("offline"));
    render(<App />);

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the not-answering message and retries when the server can't be reached", async () => {
    signIn();
    let answered = 0;
    serve({
      me: () => {
        answered += 1;
        if (answered === 1) throw new TypeError("Failed to fetch");
        return json(200, { userId: "user_1", team: "org_1", role: "member" });
      },
      findings: () => json(200, { team: "org_1", findings: [] }),
    });
    render(<App />);

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await header().findByText("Member")).toBeInTheDocument();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();
  });

  it("on a 409, says the Team's Admin must open Warden first, and keeps the person signed in", async () => {
    signIn();
    serve({ me: () => json(409, { error: "Your Team's Admin must open Warden first" }) });
    render(<App />);

    expect(
      await screen.findByText(
        "Your Team's Admin must open Warden first. Try again once they have.",
      ),
    ).toBeInTheDocument();
    expect(clerk.auth.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();
  });

  it("on a 429, says how long to wait from Retry-After, and keeps the person signed in", async () => {
    signIn();
    serve({
      me: () => json(429, { error: "Too many sign-in attempts" }, { "Retry-After": "37" }),
    });
    render(<App />);

    expect(
      await screen.findByText("Too many sign-in attempts. Try again in 37 seconds."),
    ).toBeInTheDocument();
    expect(clerk.auth.signOut).not.toHaveBeenCalled();
  });

  it("on a 429 without Retry-After, says to try again in a minute", async () => {
    signIn();
    serve({ me: () => json(429, { error: "Too many sign-in attempts" }) });
    render(<App />);

    expect(
      await screen.findByText("Too many sign-in attempts. Try again in a minute."),
    ).toBeInTheDocument();
  });
});
