// The one check of an id read from a request's path, for the app's routes and the modules' (which may import this
// file; the app still imports no module, ADR 0005).
import type { Context } from "hono";

/**
 * A path parameter as a stored id, or undefined when it can be no stored id: missing, or holding a NUL. Postgres
 * can't hold a NUL in text, and every id column is text, so a read with one would be refused as a 500. A route
 * answers undefined exactly as it answers an id the Team doesn't have, before any store sees it.
 */
export function pathId(value: string | undefined): string | undefined {
  if (value === undefined || value.includes("\0")) return undefined;
  return value;
}

/**
 * The path's `:id` as a stored id (`pathId`), or `NotFound` thrown for one that can be none: the route's own error
 * for an id the Team doesn't have, so its refusal answers the same 404.
 */
export function idParam(c: Context, NotFound: new (id: string) => Error): string {
  const raw = c.req.param("id");
  const id = pathId(raw);
  if (id === undefined) throw new NotFound(String(raw));
  return id;
}
