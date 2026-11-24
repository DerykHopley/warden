// The People page: everyone in the Team who has opened Warden, with their Role. An Admin gives Roles here.
import { useOrganization } from "@clerk/react";
import { Role, type TeamMember } from "@warden/contracts";
import { useCallback, useState } from "react";
import { tryAgainIn } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { changeMemberRole, fetchMembers, type MembersResult } from "./members.ts";
import { ROLE_WORDS } from "./roles.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** One row's change in flight (the Role chosen) or the message its last change left. */
type RowState = { pending?: Role; message?: string };

const MESSAGES = {
  "not-admin": "Only an Admin can change Roles.",
  "last-admin": "A Team needs at least one Admin.",
  "clerk-unreachable": "Clerk couldn't be reached, so nothing changed. Try again.",
  "not-answering": "Warden's server isn't answering. Try again.",
} as const;

// Said above the list, not in the row: the list is asked for again, and the person's row goes with it.
const LEFT_THE_TEAM = "This person is no longer in the Team.";

// Names live in Clerk, not Warden. A Team past this many people shows the rest by email or user id.
const MEMBERSHIPS_PAGE = { pageSize: 100 };

export function PeoplePage({ getToken, me, onSessionEnded, refreshMe }: PageProps) {
  const { memberships } = useOrganization({ memberships: MEMBERSHIPS_PAGE });
  const listMembers = useCallback(() => fetchMembers(getToken), [getToken]);
  const list = useWardenCall<MembersResult>(listMembers, onSessionEnded);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const setRow = (userId: string, state: RowState) =>
    setRows((all) => ({ ...all, [userId]: state }));

  async function change(userId: string, role: Role) {
    // A Role the person already has is sent too: the server still asks Clerk, and its answer is shown.
    setRow(userId, { pending: role });
    setNotice(null);
    const result = await changeMemberRole(getToken, userId, role);
    switch (result.kind) {
      case "changed":
        setRow(userId, {});
        list.setResult((old) =>
          old !== "loading" && old.kind === "members"
            ? {
                ...old,
                members: old.members.map((m) => (m.userId === userId ? result.member : m)),
              }
            : old,
        );
        if (userId === me.userId) refreshMe();
        return;
      case "session-ended":
        setRow(userId, {});
        onSessionEnded();
        return;
      case "no-such-member":
        setRow(userId, {});
        setNotice(LEFT_THE_TEAM);
        list.refresh();
        return;
      case "too-many-attempts":
        setRow(userId, { message: tryAgainIn(result.retryAfter) });
        return;
      default:
        setRow(userId, { message: MESSAGES[result.kind] });
        if (result.kind === "not-admin") refreshMe();
    }
  }

  const clerkUsers = new Map(
    (memberships?.data ?? []).flatMap((m) =>
      m.publicUserData?.userId ? [[m.publicUserData.userId, m.publicUserData] as const] : [],
    ),
  );
  const members =
    list.result !== "loading" && list.result.kind === "members" ? list.result.members : null;

  return (
    <>
      <h1>People</h1>
      {notice !== null && (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
      {list.result === "loading" && <p className="muted">Loading the Team's people…</p>}
      {list.result !== "loading" && <CallRefused result={list.result} onRetry={list.retry} />}
      {list.result !== "loading" && <TeamRefused result={list.result} />}
      {members?.length === 0 && <p className="muted">No one in this Team has opened Warden yet.</p>}
      {members !== null && members.length > 0 && (
        <table className={me.role === "admin" ? "people with-picker" : "people"}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col" className="joined">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <PersonRow
                key={member.userId}
                member={member}
                clerkUser={clerkUsers.get(member.userId)}
                state={rows[member.userId] ?? {}}
                picker={me.role === "admin"}
                onChange={(role) => void change(member.userId, role)}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

type ClerkUser = { firstName: string | null; lastName: string | null; identifier: string };

function PersonRow(props: {
  member: TeamMember;
  clerkUser: ClerkUser | undefined;
  state: RowState;
  picker: boolean;
  onChange: (role: Role) => void;
}) {
  const { member, clerkUser, state } = props;
  const fullName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter((part) => part?.trim())
    .join(" ");
  // Their name in Clerk, else their email, else (no Clerk membership found) their user id.
  const name = fullName || clerkUser?.identifier;
  const busy = state.pending !== undefined;

  return (
    <tr>
      <td>{name || <code>{member.userId}</code>}</td>
      <td className="role-cell">
        {props.picker ? (
          <select
            className="role-picker"
            aria-label={`Role for ${name || member.userId}`}
            value={state.pending ?? member.role}
            disabled={busy}
            aria-busy={busy}
            onChange={(event) => props.onChange(Role.parse(event.target.value))}
          >
            {Role.options.map((role) => (
              <option key={role} value={role}>
                {ROLE_WORDS[role]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_WORDS[member.role]
        )}
        {state.message !== undefined && (
          <p className="row-message" role="alert">
            {state.message}
          </p>
        )}
      </td>
      <td className="joined">
        <time dateTime={member.joinedAt}>
          {new Date(member.joinedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
        </time>
      </td>
    </tr>
  );
}
