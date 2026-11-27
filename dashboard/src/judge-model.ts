// The Judge's model calls (spec #225, slice 6b, story 10): an Admin reads the Team's own Judge model, sets it, or clears
// it to put the Team back on OpenRouter. Both routes are Admin-only, so a 403 means the Role changed since /api/me
// answered. A change's refusals read as the agent hook's do (`hook.ts`).
import { JudgeModelBody, type JudgeModelChange } from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";
import { refusalOf, type ChangeRefused } from "./hook.ts";
import { confirmTeam } from "./products.ts";

/** Setup's anchor for the Judge's model section. */
export const JUDGE_MODEL_ANCHOR = "setup-judge-model";

const JUDGE_MODEL_PATH = "/api/judge/model";

export type JudgeModelResult =
  | { kind: "model"; body: JudgeModelBody }
  /** 403: only an Admin reads the Judge's model. */
  | { kind: "not-admin" }
  | { kind: "team-not-opened" }
  | Refused;

/** `GET /api/judge/model`: the Team's own model, or null while it's judged on OpenRouter. */
export async function fetchJudgeModel(getToken: GetToken): Promise<JudgeModelResult> {
  const res = await callWarden(getToken, JUDGE_MODEL_PATH);
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "not-admin" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, JudgeModelBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "model", body };
}

export type JudgeModelChangeResult = { kind: "set"; body: JudgeModelBody } | ChangeRefused;

/**
 * `PUT /api/judge/model` with `local_model` (null clears it), once /api/me says the session is in `team` and with the
 * token that answer was asked with (`confirmTeam`), as the hook's changes are: a change is never sent for the Team
 * just left. The answer is the Team's setting after it.
 */
export async function setJudgeModel(
  getToken: GetToken,
  team: string | null,
  localModel: JudgeModelChange["local_model"],
): Promise<JudgeModelChangeResult> {
  const inTeam = await confirmTeam(getToken, team);
  if (inTeam.kind !== "confirmed") return inTeam;
  const res = await callWarden(inTeam.getToken, JUDGE_MODEL_PATH, {
    method: "PUT",
    body: { local_model: localModel },
  });
  if (!(res instanceof Response)) return res;
  const refusal = await refusalOf(res, "The Judge's model wasn't changed.");
  if (refusal !== undefined) return refusal;
  const body = await parsed(res, JudgeModelBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "set", body };
}
