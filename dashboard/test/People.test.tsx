// The People page: the Team's people with names from Clerk, and the Admin's Role picker with each answer it can get.
// Most cases render PeoplePage alone with spy props; the app-level cases cover what crosses into the shell.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { PeoplePage } from "../src/People.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { clerk, resetClerk } from "./fake-clerk.tsx";

vi.mock("@clerk/react", () => import("./fake-clerk.tsx"));

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

const row = (name: string) => {
  const tr = screen.getByText(name).closest("tr");
  if (tr === null) throw new Error(`${name} isn't in a table row`);
  return within(tr);
};

/** Renders PeoplePage alone as `role`, with the members list answered unless `routes` says otherwise. */
function renderPeople(role: Role, routes: Routes = {}) {
  serve({ members: () => json(200, members({ user_1: role })), ...routes });
  const props = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
  };
  render(<PeoplePage {...props} />);
  return props;
}

/** As renderPeople, once the table shows; then Grace's Role select. */
async function openGracePicker(routes: Routes) {
  const props = renderPeople("admin", routes);
  await screen.findByRole("table");
  return { props, select: screen.getByRole("combobox", { name: "Role for grace@example.com" }) };
}

const failsWith = (status: number, error: string) => () => json(status, { error });

describe("PeoplePage", () => {
  it("lists each person with their name from Clerk, else their email, else their user id", async () => {
    renderPeople("member");
    await screen.findByRole("table");

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Ada Lovelace",
      "grace@example.com",
      "user_3",
    ]);
    expect(screen.getByText("user_3").tagName).toBe("CODE");
    expect(callsTo("/api/team/members")[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it.each<[Role, string]>([
    ["member", "Member"],
    ["lead", "Lead"],
  ])("shows a %s every Role as text, with no picker", async (role, word) => {
    renderPeople(role);
    await screen.findByRole("table");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(row("Ada Lovelace").getByText(word)).toBeInTheDocument();
    expect(row("grace@example.com").getByText("Member")).toBeInTheDocument();
  });

  it("lets an Admin give someone a Role, busy while the change runs", async () => {
    const answer = deferred<Response>();
    const { props, select } = await openGracePicker({ changeRole: () => answer.promise });
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
    expect(props.refreshMe).not.toHaveBeenCalled();
  });

  it("on a 502, keeps the old Role and says Clerk couldn't be reached", async () => {
    const { select } = await openGracePicker({
      changeRole: failsWith(502, "Clerk didn't take the change; nothing changed"),
    });
    await userEvent.selectOptions(select, "Admin");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Clerk couldn't be reached, so nothing changed. Try again.",
    );
    expect(select).toHaveValue("member");
    expect(select).toBeEnabled();
  });

  it("on a 502 for the Role the person already has, still says so", async () => {
    const { select } = await openGracePicker({
      changeRole: failsWith(502, "Clerk didn't take the change; nothing changed"),
    });
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
    const answers = [
      json(409, { error: "A Team needs at least one Admin" }),
      json(200, { userId: "user_2", role: "lead", joinedAt }),
    ];
    const { select } = await openGracePicker({ changeRole: () => answers.shift()! });

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
    const { props, select } = await openGracePicker({
      changeRole: failsWith(403, "Your Role can't do this"),
    });
    await userEvent.selectOptions(select, "Lead");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Only an Admin can change Roles.",
    );
    expect(select).toHaveValue("member");
    expect(props.refreshMe).toHaveBeenCalledOnce();
  });

  it("on a 404, says the person left, asks again for the list, and the message outlasts their row", async () => {
    const lists = [members(), { members: members().members.filter((m) => m.userId !== "user_2") }];
    const { select } = await openGracePicker({
      members: () => json(200, lists.shift() ?? lists[0]),
      changeRole: failsWith(404, "No such member"),
    });
    await userEvent.selectOptions(select, "Lead");

    await vi.waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
    expect(callsTo("/api/team/members")).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("This person is no longer in the Team.");
  });

  it("when the change gets no answer, keeps the old Role and says the server isn't answering", async () => {
    const { select } = await openGracePicker({
      changeRole: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await userEvent.selectOptions(select, "Lead");

    expect(await row("grace@example.com").findByRole("alert")).toHaveTextContent(
      "Warden's server isn't answering. Try again.",
    );
    expect(select).toHaveValue("member");
  });

  it("when the list gets no answer, says so, and Retry shows loading until it answers", async () => {
    const second = deferred<Response>();
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => second.promise,
    ];
    renderPeople("member", { members: () => answers.shift()!() });

    expect(await screen.findByText("Warden's server isn't answering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Loading the Team's people…")).toBeInTheDocument();
    expect(screen.queryByText("Warden's server isn't answering")).not.toBeInTheDocument();

    second.resolve(json(200, members({ user_1: "member" })));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("when the list answers 403, says to choose a Team, not that the server isn't answering", async () => {
    renderPeople("member", { members: failsWith(403, "Choose a Team first") });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a Team first, from the switcher above.",
    );
    expect(screen.queryByText(/isn't answering/)).not.toBeInTheDocument();
  });

  it("when the list answers 409, says the Team's Admin must open Warden first", async () => {
    renderPeople("member", { members: failsWith(409, "Your Team's Admin must open Warden first") });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your Team's Admin must open Warden first. Try again once they have.",
    );
    expect(screen.queryByText(/isn't answering/)).not.toBeInTheDocument();
  });
});

describe("People in the app", () => {
  const header = () => within(screen.getByRole("banner"));

  function start(role: Role, routes: Routes = {}) {
    window.history.replaceState(null, "", "/people");
    serve({
      me: () => json(200, { userId: "user_1", team: "org_a", role }),
      members: () => json(200, members({ user_1: role })),
      ...routes,
    });
    render(<App />);
  }

  it("an Admin who makes themselves Lead sees Lead in the header and loses the pickers", async () => {
    let myRole: Role = "admin";
    start("admin", {
      me: () => json(200, { userId: "user_1", team: "org_a", role: myRole }),
      changeRole: (_userId, body) => {
        myRole = (body as { role: Role }).role;
        return json(200, { userId: "user_1", role: myRole, joinedAt });
      },
    });
    expect(await header().findByText("Admin")).toBeInTheDocument();

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Ada Lovelace" }),
      "Lead",
    );

    expect(await header().findByText("Lead")).toBeInTheDocument();
    expect(callsTo("/api/me")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(row("Ada Lovelace").getByText("Lead")).toBeInTheDocument();
  });

  it("when the list answers 401, ends the session", async () => {
    start("member", { members: () => json(401, { error: "Not signed in" }) });

    expect(await screen.findByText("Signing you out…")).toBeInTheDocument();
    expect(clerk.auth.signOut).toHaveBeenCalled();
  });
});
