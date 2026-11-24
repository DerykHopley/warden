// Fakes Warden's server for the dashboard's tests: each route answers what the test gives it.
import { vi } from "vitest";

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

type Answer = Response | Promise<Response>;

export type Routes = {
  me?: () => Answer;
  members?: () => Answer;
  /** PUT /api/team/members/:userId/role, with the user id and the parsed body. */
  changeRole?: (userId: string, body: unknown) => Answer;
};

export const fetchMock = vi.fn<typeof fetch>();

/** Answers each request from `routes`; a route the test didn't give is a test failure, not a silent 404. */
export function serve(routes: Routes) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/me" && method === "GET" && routes.me) return routes.me();
    if (url === "/api/team/members" && method === "GET" && routes.members) return routes.members();
    const change = /^\/api\/team\/members\/([^/]+)\/role$/.exec(url);
    if (change && method === "PUT" && routes.changeRole) {
      return routes.changeRole(decodeURIComponent(change[1] ?? ""), JSON.parse(String(init?.body)));
    }
    throw new Error(`The test gave no answer for ${method} ${url}`);
  });
}

/** The requests made to one path, as [url, init] pairs. */
export const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === path);

/** A promise the test resolves when it chooses, for an answer that arrives late. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
