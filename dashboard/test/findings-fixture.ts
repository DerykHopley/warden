// Findings as GET /api/findings answers them: each a valid Finding v1, so the page's parse takes them. `demoFindings`
// is what the server's demo seed leaves, built from the same data (`@warden/contracts/demo`): 11 Findings, 7 Open
// (2 Critical), 2 Fixed (one an Unconfirmed fix), 1 Accepted and 1 False positive, from Guard and Patch.
import {
  fingerprint,
  type Finding,
  type Location,
  type Observation,
  type Product,
} from "@warden/contracts";
import { DEMO_OBSERVATIONS, DEMO_OUTCOME, type DemoKey } from "@warden/contracts/demo";

/** The Team the fixtures belong to. */
export const TEAM = "org_a";

/** A valid Open Guard Finding on a Repo, with `id`; `fields` changes it, and the Fingerprint follows the Location. */
export function finding(id: string, fields: Partial<Finding> = {}): Finding {
  const rule_id = fields.rule_id ?? "guard/agent-can-read-env";
  const location: Location = fields.location ?? { kind: "file", path: ".claude/settings.json" };
  return {
    id,
    team: TEAM,
    asset: { kind: "repo", ref: "https://github.com/acme/shop-web" },
    module: "guard",
    severity: "high",
    title: "The agent can read .env files",
    evidence: { summary: "permissions.allow lets the agent read .env" },
    status: "open",
    unconfirmed_fix: null,
    accepted_reason: null,
    accepted_until: null,
    first_seen_scan: "demo-guard-1",
    last_seen_scan: "demo-guard-1",
    moved_to: null,
    ...fields,
    rule_id,
    location,
    fingerprint: fingerprint(rule_id, location),
  };
}

/** Ids as the server makes them: UUIDs, one per demo Finding. */
export const ID: Record<DemoKey, string> = {
  secret: "3f2a1b9c-0000-4000-8000-000000000001",
  lodash: "a1c4e7f0-0000-4000-8000-000000000002",
  envLocal: "5b6c7d8e-0000-4000-8000-000000000003",
  printed: "9e8d7c6b-0000-4000-8000-000000000004",
  minimist: "c0ffee00-0000-4000-8000-000000000005",
  disk: "d15c0000-0000-4000-8000-000000000006",
  cognito: "c0c0c0c0-0000-4000-8000-000000000007",
  envSettings: "0e0e0e0e-0000-4000-8000-000000000008",
  ws: "77777777-0000-4000-8000-000000000009",
  axios: "a8a8a8a8-0000-4000-8000-00000000000a",
  push: "b1b1b1b1-0000-4000-8000-00000000000b",
};

/** The demo Finding `name`, as the seed leaves it. */
function demoFinding(name: DemoKey): Finding {
  const observation: Observation = DEMO_OBSERVATIONS[name];
  const outcome = DEMO_OUTCOME[name];
  const module = observation.rule_id.startsWith("patch/") ? "patch" : "guard";
  return finding(ID[name], {
    ...observation,
    module,
    status: outcome.status,
    unconfirmed_fix: outcome.unconfirmedFixTo
      ? { candidates: [ID[outcome.unconfirmedFixTo]] }
      : null,
    accepted_reason: outcome.status === "accepted" ? (outcome.decidedReason ?? null) : null,
    accepted_until: outcome.status === "accepted" ? "2027-02-22T12:00:00Z" : null,
  });
}

export const demoFindings: Finding[] = (Object.keys(ID) as DemoKey[]).map(demoFinding);

/** A saved Product, "Shop web": its id is the Asset ref its Findings carry. */
export const PRODUCT_ID = "5e1f0000-0000-4000-8000-0000000000aa";
export const SHOP_WEB: Product = {
  id: PRODUCT_ID,
  name: "Shop web",
  repo_urls: [],
  dependencies: [],
};
