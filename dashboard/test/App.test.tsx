// The dashboard's sign-in states, with Clerk's React hooks stubbed and /api/me faked.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";

const clerk = vi.hoisted(() => ({
  auth: {
    isLoaded: true,
    isSignedIn: false as boolean,
    sessionId: null as string | null,
    getToken: async () => "session-token" as string | null,
    signOut: async () => {},
  },
  email: "ada@example.com",
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => clerk.auth,
  useUser: () => ({
    isLoaded: true,
    user: { primaryEmailAddress: { emailAddress: clerk.email } },
  }),
  SignIn: () => <div>Clerk sign-in</div>,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clerk.auth.isSignedIn = false;
  clerk.auth.sessionId = null;
  clerk.auth.signOut = vi.fn(async () => {});
  clerk.auth.getToken = async () => "session-token";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function signIn(sessionId = "sess_1") {
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = sessionId;
}

function signOut() {
  clerk.auth.isSignedIn = false;
  clerk.auth.sessionId = null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("App", () => {
  it("shows Clerk's sign-in when signed out", () => {
    render(<App />);
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the email, the user id the server returned and sign-out when signed in", async () => {
    signIn();
    fetchMock.mockResolvedValue(
      json(200, { userId: "user_from_server", team: "org_1", role: "admin" }),
    );
    render(<App />);

    expect(screen.getByRole("heading", { name: "Warden" })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as/)).toHaveTextContent("Signed in as ada@example.com");
    expect(await screen.findByText("user_from_server")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/me", {
      headers: { Authorization: "Bearer session-token" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(clerk.auth.signOut).toHaveBeenCalled();
  });

  it("on a 401, signs the person out, then shows the session-ended message with the sign-in", async () => {
    signIn();
    fetchMock.mockResolvedValue(json(401, { error: "Not signed in" }));
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
    fetchMock.mockResolvedValueOnce(json(401, { error: "Not signed in" }));
    const { rerender } = render(<App />);
    await screen.findByText("Signing you out…");
    signOut();
    rerender(<App />);

    fetchMock.mockResolvedValueOnce(json(200, { userId: "user_again", team: null, role: null }));
    signIn("sess_2");
    rerender(<App />);
    expect(await screen.findByText("user_again")).toBeInTheDocument();

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
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockResolvedValueOnce(
      json(200, { userId: "user_after_retry", team: "org_1", role: "member" }),
    );
    render(<App />);

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("user_after_retry")).toBeInTheDocument();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();
  });

  it("on a 409, says the Team's Admin must open Warden first, and keeps the person signed in", async () => {
    signIn();
    fetchMock.mockResolvedValue(json(409, { error: "Your Team's Admin must open Warden first" }));
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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many sign-in attempts" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "37" },
      }),
    );
    render(<App />);

    expect(
      await screen.findByText("Too many sign-in attempts. Try again in 37 seconds."),
    ).toBeInTheDocument();
    expect(clerk.auth.signOut).not.toHaveBeenCalled();
  });

  it("on a 429 without Retry-After, says to try again in a minute", async () => {
    signIn();
    fetchMock.mockResolvedValue(json(429, { error: "Too many sign-in attempts" }));
    render(<App />);

    expect(
      await screen.findByText("Too many sign-in attempts. Try again in a minute."),
    ).toBeInTheDocument();
  });
});
