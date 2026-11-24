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
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function signIn() {
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = "sess_1";
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
    fetchMock.mockResolvedValue(json(200, { userId: "user_from_server" }));
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

  it("shows the session-ended message with the sign-in on a 401", async () => {
    signIn();
    fetchMock.mockResolvedValue(json(401, { error: "Not signed in" }));
    render(<App />);

    expect(await screen.findByText("Your session has ended: sign in again")).toBeInTheDocument();
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
    expect(clerk.auth.signOut).toHaveBeenCalled();
  });

  it("keeps the session-ended message once Clerk has signed the person out", async () => {
    signIn();
    fetchMock.mockResolvedValue(json(401, { error: "Not signed in" }));
    const { rerender } = render(<App />);
    await screen.findByText("Your session has ended: sign in again");

    clerk.auth.isSignedIn = false;
    clerk.auth.sessionId = null;
    rerender(<App />);

    expect(screen.getByText("Your session has ended: sign in again")).toBeInTheDocument();
    expect(screen.getByText("Clerk sign-in")).toBeInTheDocument();
  });

  it("shows the not-answering message and retries when the server can't be reached", async () => {
    signIn();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetchMock.mockResolvedValueOnce(json(200, { userId: "user_after_retry" }));
    render(<App />);

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("user_after_retry")).toBeInTheDocument();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();
  });
});
