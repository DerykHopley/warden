// How every route words a body a schema refused, so a 400 reads the same on each: the app's own routes and the
// modules' (which may import this file; the app still imports no module, ADR 0005).
import type { z } from "zod";

/** A body a schema refused, as one line: each issue's field and message. */
export function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
