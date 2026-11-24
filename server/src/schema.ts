// The Kysely table types for what the migrations in server/migrations make. Every table here is Team-owned and kept
// apart by row-level security (ADR 0006); `findUnprotectedTables` checks that on the real schema.
import type { Generated } from "kysely";

export interface Database {
  /** One row per Team, keyed by its Clerk Organization id; every later Team-owned table points at it. */
  teams: {
    id: string;
    created_at: Generated<Date>;
  };
}
