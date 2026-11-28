// One Agent session Finding's session record (GET /api/guard/findings/:id/session, spec #225, slice 9b, story 9), for
// the detail card's Session section, and the words it shows for it.
import { AgentSessionBody } from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";
import { askInTeam } from "./products.ts";

export type SessionRecordResult =
  | { kind: "record"; record: AgentSessionBody }
  /**
   * 404: the id isn't one of the Team's Findings, it isn't on an Agent session, or its session has no record (the
   * demo's made-up one); `error` is the server's words, null when its body has none.
   */
  | { kind: "not-found"; error: string | null }
  | Refused;

/**
 * Finding `findingId`'s session record. A 403, a 409, a 5xx and a body that doesn't parse are all not answering: the
 * section offers Retry for each.
 */
export async function fetchSessionRecord(
  getToken: GetToken,
  findingId: string,
): Promise<SessionRecordResult> {
  const res = await callWarden(
    getToken,
    `/api/guard/findings/${encodeURIComponent(findingId)}/session`,
  );
  if (!(res instanceof Response)) return res;
  if (res.status === 404) return { kind: "not-found", error: await serverError(res) };
  const record = await parsed(res, AgentSessionBody);
  return record === undefined ? { kind: "not-answering" } : { kind: "record", record };
}

/**
 * Asks as `fetchSessionRecord` does, but only once /api/me says the session is in `team`, the Finding's Team
 * (`askInTeam`): the record names no Team. While /api/me names another Team, or gives no answer, nothing is asked and
 * Retry shows.
 */
export const fetchSessionRecordInTeam = (
  getToken: GetToken,
  team: string,
  findingId: string,
): Promise<SessionRecordResult> =>
  askInTeam(getToken, team, (confirmed) => fetchSessionRecord(confirmed, findingId));

/** How many of the pseudonym's 64 hex digits show: enough to tell two sessions apart, short enough not to wrap. */
const PSEUDONYM_DIGITS = 12;

/** A pseudonym as the section shows it: its first 12 hex digits, then "…". */
export const shortPseudonym = (developer: string) => `${developer.slice(0, PSEUDONYM_DIGITS)}…`;

export const SESSION_LOADING = "Loading the session…";
export const SESSION_FAILED = "Couldn't load the session.";
/** A 404 whose body names no reason. */
export const NO_SESSION_RECORD = "Warden holds no record of this session.";
export const NOT_NAMED = "Not named";
export const NOT_ENDED = "Not ended";
export const NOT_JUDGED = "Not judged";
