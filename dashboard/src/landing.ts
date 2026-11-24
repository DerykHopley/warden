// The page a person lands on at `/`, by their Role (docs/design.md, Roles): the one place this map lives.
import type { Role } from "@warden/contracts";

/** Member → Findings. Lead and Admin land on Findings too until the Overview exists (slice 10 changes their entry). */
const LANDING: Record<Role, string> = {
  member: "/findings",
  lead: "/findings",
  admin: "/findings",
};

export const landingPage = (role: Role): string => LANDING[role];
