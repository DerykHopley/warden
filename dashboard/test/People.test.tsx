// The People page: the Team's people with names from Clerk, and the Admin's Role picker with each answer it can get.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

type Role = "member" | "lead" | "admin";

const joinedAt = "2026-11-20T09:00:00.000Z";
// Oldest first, as the server sends them. user_1 is the person signed in.
const members = (roles: Partial<Record<string, Role>> = {}) => ({
  members: [
    { userId: "user_1", role: roles.user_1 ?? "admin", joinedAt },
    { userId: "user_2", role: roles.user_2 ?? "member", joinedAt },
    { userId: "user_3", role: roles.user_3 ?? "member", joinedAt },
  ],
});

beforeEach(() => {
  resetClerk();
  clerk.auth.isSignedIn = true;
  clerk.auth.sessionId = "sess_1";
  clerk.auth.orgId = "org_a";
  clerk.orgNames = { org_a: "Acme" };
  // user_1 has a name in Clerk, user_2 only an email, user_3 no Clerk membership at all.
  clerk.memberships = [
    {
      publicUserData: {
        userId: "user_1",
        firstName: "Ada",
        lastName: "Lovelace",
        identifier: "ada@example.com",
      },
    },
    {
      publicUserData: {
        userId: "user_2",
        firstName: null,
        lastName: null,
        identifier: "grace@example.com",
      },
    },
  ];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const header = () => within(screen.getByRole("banner"));
const row = (name: string) => {
  const cell = screen.getByText(name);
  const tr = cell.closest("tr");
  if (tr === null) throw new Error(`${name} isn't in a table row`);
  return within(tr);
};

/** Opens Warden as `role`, with the server answering `routes` on top of /api/me and the members list. */
function start(role: Role, routes: Routes = {}) {
  serve({
    me: () => json(200, { userId: "user_1", team: "org_a", role }),
    members: () => json(200, members({ user_1: role })),
    ...routes,
  });
  render(<App />);
}

/** Opens People as `role`, once its table shows. */
async function openPeople(role: Role, routes: Routes = {}) {
  start(role, routes);
  await screen.findByRole("table");
}

describe("PeoplePage", () => {
  it("lists each person with their name from Clerk, else their email, else their user id", async () => {
    await openPeople("member");

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Ada Lovelace",
      "grace@example.com",
      "user_3",
    ]);
    expect(screen.getByText("user_3").tagName).toBe("CODE");
    expect(callsTo("/api/team/members")[0]?.[1]).toEqual({
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("shows a Member every Role as text, with no picker", async () => {
    await openPeople("member");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(row("Ada Lovelace").getByText("Member")).toBeInTheDocument();
    expect(row("user_3").getByText("Member")).toBeInTheDocument();
  });

  it("shows a Lead every Role as text, with no picker", async () => {
    await openPeople("lead");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(row("Ada Lovelace").getByText("Lead")).toBeInTheDocument();
    expect(row("grace@example.com").getByText("Member")).toBeInTheDocument();
  });

  it("lets an Admin give someone a Role, busy while the change runs", async () => {
    const answer = deferred<Response>();
    await openPeople("admin", { changeRole: () => answer.promise });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    await userEvent.selectOptions(select, "Lead");

    const [url, init] = callsTo("/api/team/members/user_2/role")[0] ?? [];
    expect(url).toBe("/api/team/members/user_2/role");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ role: "lead" });
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-busy", "true");

    answer.resolve(json(200, { userId: "user_2", role: "lead", joinedAt }));
    await vi.waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("lead");
    expect(select).not.toHaveAttribute("aria-busy", "true");
    // Someone else's Role changed, so the Admin's own answer isn't asked for again.
    expect(callsTo("/api/me")).toHaveLength(1);
  });

  it("on a 502, keeps the old Role and says Clerk couldn't be reached", async () => {
    await openPeople("admin", {
      changeRole: () => json(502, { error: "Clerk didn't take the change; nothing changed" }),
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Admin");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Clerk couldn't be reached, so nothing changed. Try again.",
    );
    expect(select).toHaveValue("member");
    expect(select).toBeEnabled();
  });

  it("on a 502 for the Role the person already has, still says so", async () => {
    await openPeople("admin", {
      changeRole: () => json(502, { error: "Clerk didn't take the change; nothing changed" }),
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Member");

    expect(JSON.parse(String(callsTo("/api/team/members/user_2/role")[0]?.[1]?.body))).toEqual({
      role: "member",
    });
    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Clerk couldn't be reached, so nothing changed. Try again.",
    );
    expect(select).toHaveValue("member");
  });

  it("on a 409, keeps the old Role and says a Team needs an Admin; the next change clears it", async () => {
    let answers = 0;
    await openPeople("admin", {
      changeRole: () => {
        answers += 1;
        return answers === 1
          ? json(409, { error: "A Team needs at least one Admin" })
          : json(200, { userId: "user_2", role: "lead", joinedAt });
      },
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Admin");
    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "A Team needs at least one Admin.",
    );
    expect(select).toHaveValue("member");

    await userEvent.selectOptions(select, "Lead");
    await vi.waitFor(() => expect(select).toHaveValue("lead"));
    expect(row("grace@example.com").queryByRole("alert")).not.toBeInTheDocument();
  });

  it("on a 403, keeps the old Role, says only an Admin can, and asks again for the person's Role", async () => {
    await openPeople("admin", {
      changeRole: () => json(403, { error: "Your Role can't do this" }),
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Lead");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Only an Admin can change Roles.",
    );
    expect(select).toHaveValue("member");
    await vi.waitFor(() => expect(callsTo("/api/me")).toHaveLength(2));
  });

  it("on a 404, keeps the old Role, says the person left, and asks again for the list", async () => {
    await openPeople("admin", {
      changeRole: () => json(404, { error: "No such member" }),
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Lead");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "This person is no longer in the Team.",
    );
    expect(select).toHaveValue("member");
    await vi.waitFor(() => expect(callsTo("/api/team/members")).toHaveLength(2));
  });

  it("when the change gets no answer, keeps the old Role and says the server isn't answering", async () => {
    await openPeople("admin", {
      changeRole: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    const select = screen.getByRole("combobox", { name: "Role for grace@example.com" });
    await userEvent.selectOptions(select, "Lead");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Warden's server isn't answering. Try again.",
    );
    expect(select).toHaveValue("member");
  });

  it("an Admin who makes themselves Lead sees Lead in the header and loses the pickers", async () => {
    let myRole: Role = "admin";
    await openPeople("admin", {
      me: () => json(200, { userId: "user_1", team: "org_a", role: myRole }),
      changeRole: (_userId, body) => {
        myRole = (body as { role: Role }).role;
        return json(200, { userId: "user_1", role: myRole, joinedAt });
      },
    });
    expect(await header().findByText("Admin")).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
      "Lead",
    );

    expect(await header().findByText("Lead")).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(row("Ada Lovelace").getByText("Lead")).toBeInTheDocument();
  });

  it("when the list gets no answer, says so and retries", async () => {
    let answers = 0;
    start("member", {
      members: () => {
        answers += 1;
        if (answers === 1) throw new TypeError("Failed to fetch");
        return json(200, members({ user_1: "member" }));
      },
    });

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("when the list answers 401, ends the session", async () => {
    start("member", { members: () => json(401, { error: "Not signed in" }) });

    expect(await screen.findByText("Signing you out…")).toBeInTheDocument();
    expect(clerk.auth.signOut).toHaveBeenCalled();
  });
});
