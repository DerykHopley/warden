// The write grant's routes (#224, stories 5 and 15), mounted by the app through `moduleRoutes` beside Guard's (ADR
// 0005). An Admin grants write access by linking an installation of Warden's write GitHub app, which Fix PRs go
// through: checked as the read app's link is, against their own sign-in through the write app's OAuth, and refused
// unless its token holds exactly the write app's three permissions. The Team is always the session's, never the
// request's.
import type { WriteGrantBody, WriteGrantsBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import {
  gitHubAppRoute,
  gitHubLinkRoute,
  permissionsMatch,
  type GitHubClient,
} from "./github-link.ts";
import type { WriteGrant, WriteGrants } from "./write-grants.ts";

/**
 * The write app's permissions (threat G2): contents and pull requests to write, to make the branch and open the PR, and
 * metadata to read, which GitHub gives every app. Workflows aren't among them: no Fix PR edits `.github/workflows/`.
 */
const WRITE_APP: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

/**
 * Whether an installation token holds exactly the write app's permissions: each of the three at its level, and nothing
 * else. Fails closed, as the read app's check does: a token naming none, or only some, isn't the write app's.
 */
export function holdsWriteAppPermissions(permissions: Record<string, string>) {
  return permissionsMatch(WRITE_APP, permissions, { exact: true });
}

const NOT_SET_UP = "Fix PRs aren't set up on this Warden";

function writeGrantBody(grant: WriteGrant): WriteGrantBody {
  return {
    installation_id: grant.installationId,
    granted_by: grant.grantedBy,
    granted_at: grant.grantedAt.toISOString(),
  };
}

/**
 * The write grant's routes; linking needs the write app's `github`, which comes with the logger its failures are
 * written to. `now` is the clock the write app's kept slug ages by. Without `github`, the Admin routes answer 503 and
 * the grant is still read.
 */
export function writeGrantRoutes(
  deps: { writeGrants: WriteGrants; now?: () => number } & GitHubClient,
): MountRoutes {
  const { writeGrants, now = Date.now } = deps;
  const answerApp = gitHubAppRoute("write", deps, NOT_SET_UP, now);
  // An Admin links a write-app installation to the session's Team (stories 5 and 15). The link adds no Repo Asset and
  // starts no Scan. It has its own hourly count, apart from the read app's.
  const linkWriteApp = gitHubLinkRoute({
    app: "write",
    client: deps,
    notSetUp: NOT_SET_UP,
    permitted: holdsWriteAppPermissions,
    notPermitted: "This installation's permissions aren't the write app's",
    linkedElsewhere: "This write installation is linked to another Team",
    async link({ team, installationId, linkedBy }) {
      // A grant the Team already holds answers 200, and the store writes no row for it. Two first links at once may
      // both answer 201, while the store still writes one row.
      const held = (await writeGrants.list(team)).some(
        (grant) => grant.installationId === installationId,
      );
      return {
        held,
        grant: await writeGrants.grant(team, { installationId, grantedBy: linkedBy }),
      };
    },
    answer: (c, { held, grant }) =>
      c.json(writeGrantBody(grant) satisfies WriteGrantBody, held ? 200 : 201),
  });

  return (app, requireRole) => {
    // What an Admin's Setup builds the write app's install and sign-in links from (story 5).
    app.get("/api/github/write-app", requireRole("admin"), answerApp);

    // Any person in the Team reads its write grants: a Member's Fix PR button needs one (#224, slice 5).
    app.get("/api/github/write-grant", requireRole("member"), async (c) =>
      c.json({
        installations: (await writeGrants.list(c.get("team"))).map(writeGrantBody),
      } satisfies WriteGrantsBody),
    );

    app.post("/api/github/write-installations", requireRole("admin"), linkWriteApp);
  };
}
