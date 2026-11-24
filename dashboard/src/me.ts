// Asks the server who the signed-in person is, so the page shows that their session token reached it and passed.
import { MeBody } from "@warden/contracts";

export type MeResult =
  { kind: "signed-in"; userId: string } | { kind: "session-ended" } | { kind: "not-answering" };

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
  const body = res.ok ? MeBody.safeParse(await res.json().catch(() => null)) : undefined;
  return body?.success
    ? { kind: "signed-in", userId: body.data.userId }
    : { kind: "not-answering" };
}
