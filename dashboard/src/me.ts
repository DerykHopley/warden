// Asks the server who the signed-in person is, so the page shows that their session token reached it and passed.
import { MeBody } from "@warden/contracts";

export type MeResult =
  | { kind: "signed-in"; userId: string }
  | { kind: "session-ended" }
  /** 409: the person's Team has no Warden Team yet, and only its Clerk Admin's first visit creates it. */
  | { kind: "team-not-opened" }
  /** 429: too many failed sign-ins from this address; seconds to wait, when the server said. */
  | { kind: "too-many-attempts"; retryAfter: number | null }
  | { kind: "not-answering" };

export async function fetchMe(getToken: () => Promise<string | null>): Promise<MeResult> {
  let res: Response;
  try {
    // Offline, Clerk can't refresh the token either: that's not answering too, never a page stuck checking.
    const token = await getToken();
    if (token === null) return { kind: "session-ended" };
    res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { kind: "not-answering" };
  }
  if (res.status === 401) return { kind: "session-ended" };
  if (res.status === 409) return { kind: "team-not-opened" };
  if (res.status === 429) {
    const seconds = Number(res.headers.get("Retry-After"));
    return {
      kind: "too-many-attempts",
      retryAfter: Number.isInteger(seconds) && seconds > 0 ? seconds : null,
    };
  }
  const body = res.ok ? MeBody.safeParse(await res.json().catch(() => null)) : undefined;
  return body?.success
    ? { kind: "signed-in", userId: body.data.userId }
    : { kind: "not-answering" };
}
