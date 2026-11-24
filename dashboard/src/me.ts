// Asks the server who the signed-in person is: their user id, and their Team and Role in it (both null with no Team).
import { MeBody } from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

export type MeResult =
  | ({ kind: "signed-in" } & MeBody)
  /** 409: the person's Team has no Warden Team yet, and only its Clerk Admin's first visit creates it. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchMe(getToken: GetToken): Promise<MeResult> {
  const res = await callWarden(getToken, "/api/me");
  if (!(res instanceof Response)) return res;
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, MeBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "signed-in", ...body };
}
