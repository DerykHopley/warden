// The agent hook's calls (Guard spec, story 7): an Admin reads the Team's hook settings, issues or rotates its hook
// token, and sets its Privacy tier. Every route is Admin-only, so a 403 means the Role changed since /api/me answered.
import {
  HOOK_TOKEN_PLACEHOLDER,
  HookSettingsBody,
  HookTokenBody,
  type PrivacyTier,
} from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";
import { confirmTeam, type TeamCheckRefused } from "./products.ts";

export type HookSettingsResult =
  | { kind: "settings"; settings: HookSettingsBody }
  /** 403: only an Admin reads the hook settings. */
  | { kind: "not-admin" }
  | { kind: "team-not-opened" }
  | Refused;

/** `GET /api/hook`: the Team's token times, Privacy tier and managed-settings block, never a token. */
export async function fetchHookSettings(getToken: GetToken): Promise<HookSettingsResult> {
  const res = await callWarden(getToken, "/api/hook");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "not-admin" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, HookSettingsBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "settings", settings: body };
}

/** A change's refusals: nothing was changed. */
type ChangeRefused =
  /** 403: only an Admin changes the hook. */
  | { kind: "forbidden" }
  /** Any other refusal, in the server's words when it gave some. */
  | { kind: "refused"; words: string }
  | { kind: "team-not-opened" }
  | Refused
  | TeamCheckRefused;

/** The refusal `res` is, or undefined when it answered 2xx. */
async function refusalOf(res: Response, unchanged: string): Promise<ChangeRefused | undefined> {
  if (res.ok) return undefined;
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 409) return { kind: "team-not-opened" };
  return { kind: "refused", words: (await serverError(res)) ?? unchanged };
}

export type IssueResult = { kind: "issued"; issued: HookTokenBody } | ChangeRefused;

/**
 * `POST /api/hook/token`, once /api/me says the session is in `team` and with the token that answer was asked with
 * (`confirmTeam`): a rotation is never sent for the Team just left. The answer holds the new token, this once.
 */
export async function issueHookToken(
  getToken: GetToken,
  team: string | null,
): Promise<IssueResult> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  const res = await callWarden(inTeam.getToken, "/api/hook/token", { method: "POST" });
  if (!(res instanceof Response)) return res;
  const refusal = await refusalOf(res, "No hook token was issued.");
  if (refusal !== undefined) return refusal;
  const issued = await parsed(res, HookTokenBody);
  return issued === undefined ? { kind: "not-answering" } : { kind: "issued", issued };
}

export type TierResult = { kind: "set"; settings: HookSettingsBody } | ChangeRefused;

/** `PUT /api/hook/privacy-tier`, in `team` as `issueHookToken` is; the answer is the Team's settings at the new tier. */
export async function setPrivacyTier(
  getToken: GetToken,
  team: string | null,
  tier: PrivacyTier,
): Promise<TierResult> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  const res = await callWarden(inTeam.getToken, "/api/hook/privacy-tier", {
    method: "PUT",
    body: { privacy_tier: tier },
  });
  if (!(res instanceof Response)) return res;
  const refusal = await refusalOf(res, "The Privacy tier wasn't changed.");
  if (refusal !== undefined) return refusal;
  const settings = await parsed(res, HookSettingsBody);
  return settings === undefined ? { kind: "not-answering" } : { kind: "set", settings };
}

/**
 * The block as an Admin pastes it: JSON with a 2-space indent, with `token` (one the page holds, just issued) in the
 * placeholder's place, so a block read again after a tier change still works.
 */
export function blockText(block: Record<string, unknown>, token: string | null): string {
  const text = JSON.stringify(block, null, 2);
  // As a JSON string's inside: a token needs no escaping, but the block stays JSON whatever it holds.
  return token === null
    ? text
    : text.replaceAll(HOOK_TOKEN_PLACEHOLDER, JSON.stringify(token).slice(1, -1));
}
