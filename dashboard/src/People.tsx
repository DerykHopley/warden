// The People page: everyone in the Team who has opened Warden, with their Role. An Admin gives Roles here.
import { useOrganization } from "@clerk/react";
import { Role, type TeamMember } from "@warden/contracts";
import { useEffect, useState } from "react";
import { tryAgainIn, type GetToken } from "./api.ts";
import { changeMemberRole, fetchMembers, type MembersResult } from "./members.ts";

export const ROLE_WORDS: Record<Role, string> = { member: "Member", lead: "Lead", admin: "Admin" };

export type PeopleProps = {
  getToken: GetToken;
  /** The person signed in, and their Role in this Team as /api/me last answered it. */
  me: { userId: string; role: Role | null };
  onSessionEnded: () => void;
  /** Ask /api/me again, after a change that may have moved the person's own Role. */
  refreshMe: () => void;
};

/** One row's change in flight (the Role chosen) or the message its last change left. */
type RowState = { pending?: Role; message?: string };

const MESSAGES = {
  "not-admin": "Only an Admin can change Roles.",
  "last-admin": "A Team needs at least one Admin.",
  "clerk-unreachable": "Clerk couldn't be reached, so nothing changed. Try again.",
  "no-such-member": "This person is no longer in the Team.",
  "not-answering": "Warden's server isn't answering. Try again.",
} as const;

// Names live in Clerk, not Warden. A Team past this many people shows the rest by email or user id.
const MEMBERSHIPS_PAGE = { pageSize: 100 };

export function PeoplePage({ getToken, me, onSessionEnded, refreshMe }: PeopleProps) {
  const { memberships } = useOrganization({ memberships: MEMBERSHIPS_PAGE });
  const [list, setList] = useState<MembersResult | "loading">("loading");
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let current = true;
    void fetchMembers(getToken).then((result) => {
      if (!current) return;
      setList(result);
      if (result.kind === "session-ended") onSessionEnded();
    });
    return () => {
      current = false;
    };
  }, [getToken, onSessionEnded, attempt]);

  const setRow = (userId: string, state: RowState) =>
    setRows((all) => ({ ...all, [userId]: state }));

  async function change(userId: string, role: Role) {
    // A Role the person already has is sent too: the server still asks Clerk, and its answer is shown.
    setRow(userId, { pending: role });
    const result = await changeMemberRole(getToken, userId, role);
    switch (result.kind) {
      case "changed":
        setRow(userId, {});
        setList((old) =>
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
      case "too-many-attempts":
        setRow(userId, { message: tryAgainIn(result.retryAfter) });
        return;
      default:
        setRow(userId, { message: MESSAGES[result.kind] });
        if (result.kind === "not-admin") refreshMe();
        if (result.kind === "no-such-member") setAttempt((n) => n + 1);
    }
  }

  const names = new Map(
    (memberships?.data ?? []).flatMap((m) =>
      m.publicUserData?.userId ? [[m.publicUserData.userId, m.publicUserData] as const] : [],
    ),
  );

  return (
    <>
      <h1>People</h1>
      {list === "loading" && <p className="muted">Loading the Team's people…</p>}
      {list !== "loading" && list.kind === "not-answering" && (
        <>
          <p className="notice" role="alert">
            Warden's server isn't answering
          </p>
          <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </>
      )}
      {list !== "loading" && list.kind === "too-many-attempts" && (
        <p className="notice" role="alert">
          {tryAgainIn(list.retryAfter)}
        </p>
      )}
      {list !== "loading" && list.kind === "members" && list.members.length === 0 && (
        <p className="muted">No one in this Team has opened Warden yet.</p>
      )}
      {list !== "loading" && list.kind === "members" && list.members.length > 0 && (
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
            {list.members.map((member) => (
              <PersonRow
                key={member.userId}
                member={member}
                name={names.get(member.userId)}
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

type ClerkName = { firstName: string | null; lastName: string | null; identifier: string };

function PersonRow(props: {
  member: TeamMember;
  name: ClerkName | undefined;
  state: RowState;
  picker: boolean;
  onChange: (role: Role) => void;
}) {
  const { member, state } = props;
  const fullName = [props.name?.firstName, props.name?.lastName]
    .filter((part) => part?.trim())
    .join(" ");
  // Their name in Clerk, else their email, else (no Clerk membership found) their user id.
  const name = fullName || props.name?.identifier;
  const busy = state.pending !== undefined;

  return (
    <tr>
      <td>{name || <code>{member.userId}</code>}</td>
      <td className="role-cell">
        {props.picker ? (
          <select
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
