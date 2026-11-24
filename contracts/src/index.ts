// The shared contracts: the API bodies the server sends and the dashboard reads, and Finding v1 with what a module
// hands over. One zod schema gives both the type and the check. The dashboard bundles this entry point, so nothing
// here may touch the file system; the reconcile cases load from `@warden/contracts/reconcile-cases`.
import { z } from "zod";

export * from "./finding.ts";
export { fingerprint } from "./fingerprint.ts";
export { agentEventsHash } from "./agent-events-hash.ts";
export * from "./reconcile-case.ts";

/** `GET /api/health`: 200 when every part is ok, 503 naming the part that failed. */
export const HealthBody = z.object({
  status: z.enum(["ok", "unavailable"]),
  database: z.enum(["ok", "unreachable"]),
  /** Whether Postgres lists the `vector` extension as available; `unknown` when the database can't be reached. */
  vector: z.enum(["available", "missing", "unknown"]),
});
export type HealthBody = z.infer<typeof HealthBody>;

/** `GET /api/me`: the signed-in person, as the server read them from their Clerk session token. */
export const MeBody = z.object({
  userId: z.string().min(1),
});
export type MeBody = z.infer<typeof MeBody>;
