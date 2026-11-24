// The page a person lands on at `/`, by their Role (docs/design.md, Roles): the one place this map lives.
import type { Role } from "@warden/contracts";

/** Member → Findings; Lead and Admin → Overview. */
const LANDING: Record<Role, string> = {
  member: "/findings",
  lead: "/overview",
  admin: "/overview",
};

export const landingPage = (role: Role): string => LANDING[role];
