// One call to Warden's server with the person's Clerk session token, and the answers every route shares:
// the session ended, too many sign-in attempts, or no answer at all. Each route's module reads the rest.

export type Refused =
  | { kind: "session-ended" }
  /** 429: too many failed sign-ins from this address; seconds to wait, when the server said. */
  | { kind: "too-many-attempts"; retryAfter: number | null }
  | { kind: "not-answering" };

export type GetToken = () => Promise<string | null>;

export async function callWarden(
  getToken: GetToken,
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<Response | Refused> {
  let res: Response;
  try {
    // Offline, Clerk can't refresh the token either: that's not answering too, never a page stuck checking.
    const token = await getToken();
    if (token === null) return { kind: "session-ended" };
    const authorization = { Authorization: `Bearer ${token}` };
    res = await fetch(
      path,
      body === undefined
        ? { method, headers: authorization }
        : {
            method,
            headers: { ...authorization, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  } catch {
    return { kind: "not-answering" };
  }
  if (res.status === 401) return { kind: "session-ended" };
  if (res.status === 429) {
    const seconds = Number(res.headers.get("Retry-After"));
    return {
      kind: "too-many-attempts",
      retryAfter: Number.isInteger(seconds) && seconds > 0 ? seconds : null,
    };
  }
  return res;
}

/** The body of a 2xx answer parsed by `schema`, or undefined for any other answer or a body that doesn't parse. */
export async function parsed<T>(
  res: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  if (!res.ok) return undefined;
  const body = schema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data : undefined;
}

/** A 409 from any route: the person's Team has no Warden Team yet, and only its Clerk Admin's first visit creates it. */
export const TEAM_NOT_OPENED =
  "Your Team's Admin must open Warden first. Try again once they have.";

export const tryAgainIn = (retryAfter: number | null) =>
  `Too many sign-in attempts. Try again in ${retryAfter === null ? "a minute" : `${retryAfter} seconds`}.`;
