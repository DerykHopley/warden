// A refused change to an Admin's setting on Setup, read from the answer and put in words the same way for each: the
// agent hook's (`hook.ts`, `HookSection.tsx`) and the Judge's model's (`judge-model.ts`, `JudgeModelSection.tsx`).
import { NOT_ANSWERING, serverError, TEAM_NOT_OPENED, tryAgainIn, type Refused } from "./api.ts";
import type { TeamCheckRefused } from "./products.ts";

/** A change's refusals: nothing was changed. */
export type ChangeRefused =
  /** 403: only an Admin changes the setting. */
  | { kind: "forbidden" }
  /** Any other refusal, in the server's words when it gave some. */
  | { kind: "refused"; words: string }
  | { kind: "team-not-opened" }
  | Refused
  | TeamCheckRefused;

/** The refusal `res` is, or undefined when it answered 2xx; `unchanged` says so when the server gave no words. */
export async function refusalOf(
  res: Response,
  unchanged: string,
): Promise<ChangeRefused | undefined> {
  if (res.ok) return undefined;
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 409) return { kind: "team-not-opened" };
  return { kind: "refused", words: (await serverError(res)) ?? unchanged };
}

/** A refused change in words (`onlyAdmin` for a 403), or null for a session that ended (the shell signs out). */
export function refusalWords(result: ChangeRefused, onlyAdmin: string): string | null {
  switch (result.kind) {
    case "forbidden":
      return onlyAdmin;
    case "refused":
      return result.words;
    case "team-not-opened":
      return TEAM_NOT_OPENED;
    case "too-many-attempts":
    case "too-many-sign-ins":
      return tryAgainIn(result.retryAfter);
    case "not-answering":
      return NOT_ANSWERING;
    case "session-ended":
      return null;
  }
}
