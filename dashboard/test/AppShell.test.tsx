// The app shell's header and its Team: the Team's name from Clerk, the Role from /api/me, and an Organization switch.
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { callsTo, deferred, fetchMock, json, serve } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

beforeEach(() => {
  resetClerk();
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = "sess_1";
  clerk.orgNames = { org_a: "Acme", org_b: "Bluebird" };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const header = () => within(screen.getByRole("banner"));
const me = (team: string | null, role: string | null) =>
  json(200, { userId: "user_1", team, role });

describe("AppShell", () => {
  it("shows the Team's name, the Role as a word, the Organization switcher and Sign out", async () => {
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "admin"), members: () => json(200, { members: [] }) });
    render(<App />);

    expect(await header().findByText("Admin")).toBeInTheDocument();
    expect(header().getByText("Acme")).toBeInTheDocument();
    expect(header().getByText("Warden")).toBeInTheDocument();
    expect(header().getByText("Clerk organization switcher")).toBeInTheDocument();
    expect(header().getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(header().getByRole("link", { name: "People" })).toHaveAttribute("href", "/people");
    // "Personal account" is never a choice: Warden works only inside a Team.
    expect(clerk.switcherProps.at(-1)).toMatchObject({ hidePersonal: true });
  });

  it("with no active Organization, asks the person to create or choose a Team, and shows no Role", async () => {
    serve({ me: () => me(null, null) });
    render(<App />);

    expect(
      await screen.findByText("Create a Team, or choose one you've been invited to"),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Clerk organization switcher");
    for (const word of ["Member", "Lead", "Admin"]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
    expect(callsTo("/api/team/members")).toHaveLength(0);
  });

  it("on an Organization switch, asks again for the person's Role and the Team's people", async () => {
    clerk.auth.orgId = "org_a";
    serve({ me: () => me("org_a", "admin"), members: () => json(200, { members: [] }) });
    const { rerender } = render(<App />);
    expect(await header().findByText("Admin")).toBeInTheDocument();
    await screen.findByText("No one in this Team has opened Warden yet.");
    expect(callsTo("/api/me")).toHaveLength(1);
    expect(callsTo("/api/team/members")).toHaveLength(1);

    clerk.auth.orgId = "org_b";
    serve({ me: () => me("org_b", "lead"), members: () => json(200, { members: [] }) });
    rerender(<App />);

    expect(await header().findByText("Lead")).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
    await screen.findByText("No one in this Team has opened Warden yet.");
    expect(callsTo("/api/me")).toHaveLength(2);
    expect(callsTo("/api/team/members")).toHaveLength(2);
  });

  it("drops a slow answer for the Team the person switched away from", async () => {
    clerk.auth.orgId = "org_a";
    const slowA = deferred<Response>();
    serve({ me: () => slowA.promise, members: () => json(200, { members: [] }) });
    const { rerender } = render(<App />);
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(1));

    clerk.auth.orgId = "org_b";
    const slowB = deferred<Response>();
    serve({ me: () => slowB.promise, members: () => json(200, { members: [] }) });
    rerender(<App />);
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(2));

    slowA.resolve(me("org_a", "admin"));
    // Team A's answer arrives while Team B is active: it never shows, and the header waits for Team B's.
    await new Promise((r) => setTimeout(r, 0));
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
    expect(header().queryByText("Acme")).not.toBeInTheDocument();
    expect(header().getAllByText("…")).toHaveLength(2);

    slowB.resolve(me("org_b", "member"));
    expect(await header().findByText("Member")).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
  });

  it("asks again when the server answers about another Team, and shows the answer about this one", async () => {
    clerk.auth.orgId = "org_b";
    const answers = [me("org_a", "admin"), me("org_b", "lead")];
    serve({
      me: () => answers.shift() ?? me("org_b", "lead"),
      members: () => json(200, { members: [] }),
    });
    render(<App />);

    expect(await header().findByText("Lead", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(header().getByText("Bluebird")).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(2);
  });

  it("stops asking after three tries about another Team, and offers Retry", async () => {
    clerk.auth.orgId = "org_b";
    serve({ me: () => me("org_a", "admin") });
    render(<App />);

    expect(
      await screen.findByText("Warden's server isn't answering", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(header().queryByText("Admin")).not.toBeInTheDocument();
  });
});
