// The write grant's routes (#224, stories 5 and 15), mounted by the app through `moduleRoutes` beside Guard's (ADR
// 0005). An Admin grants write access by linking an installation of Warden's write GitHub app, which Fix PRs go
// through: checked as the read app's link is, against their own sign-in through the write app's OAuth, and refused
// unless its token holds exactly the write app's three permissions. The Team is always the session's, never the
// request's.
import { LinkInstallationBody, type WriteGrantBody, type WriteGrantsBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import type { Logger } from "../../log.ts";
import { refusedBody } from "../../refused-body.ts";
import {
  GitHubInstallationUnreachable,
  GitHubRefusedCode,
  GitHubUnavailable,
  type GitHub,
} from "./github.ts";
import { InstallationLinkedElsewhere } from "./repo-assets.ts";
import { gitHubAppAnswer, LINKS_PER_HOUR } from "./routes.ts";
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
  const named = Object.entries(permissions);
  return (
    named.length === Object.keys(WRITE_APP).length &&
    named.every(([name, level]) => WRITE_APP[name] === level)
  );
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
  deps: { writeGrants: WriteGrants; now?: () => number } & (
    { github: GitHub; logger: Logger } | { github?: undefined; logger?: Logger }
  ),
): MountRoutes {
  const { writeGrants, now = Date.now } = deps;
  // Its own count, apart from the read app's: kept in this instance's memory, keyed by Team id (threat A5).
  const linkLimit = createAttemptLimit({ max: LINKS_PER_HOUR, windowMs: 3_600_000 });
  const answerApp = deps.github ? gitHubAppAnswer(deps.github, deps.logger, now) : undefined;

  return (app, requireRole) => {
    // What an Admin's Setup builds the write app's install and sign-in links from (story 5).
    app.get("/api/github/write-app", requireRole("admin"), (c) =>
      answerApp ? answerApp(c) : c.json({ error: NOT_SET_UP }, 503),
    );

    // Any person in the Team reads its write grants: a Member's Fix PR button needs one (#224, slice 5).
    app.get("/api/github/write-grant", requireRole("member"), async (c) =>
      c.json({
        installations: (await writeGrants.list(c.get("team"))).map(writeGrantBody),
      } satisfies WriteGrantsBody),
    );

    // An Admin links a write-app installation to the session's Team (stories 5 and 15). Every refusal writes nothing;
    // the link adds no Repo Asset and starts no Scan, and neither token is kept.
    app.post("/api/github/write-installations", requireRole("admin"), async (c) => {
      if (deps.github === undefined) return c.json({ error: NOT_SET_UP }, 503);
      const { github, logger } = deps;
      // A body that isn't JSON parses as undefined, which the schema refuses.
      const parsed = LinkInstallationBody.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const team = c.get("team");
      const retryAfter = linkLimit.attempt(team);
      if (retryAfter !== undefined) {
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: `A Team links at most ${LINKS_PER_HOUR} times an hour` }, 429);
      }

      const { installation_id: installationId, code, code_verifier: codeVerifier } = parsed.data;
      try {
        // Only whether the person reaches the installation: the repos they read in it aren't stored.
        const repos = await github.userInstallationRepos(code, codeVerifier, installationId);
        if (repos === undefined) {
          return c.json({ error: "You can't reach this installation on GitHub" }, 403);
        }
        if (!holdsWriteAppPermissions(await github.installationPermissions(installationId))) {
          return c.json({ error: "This installation's permissions aren't the write app's" }, 409);
        }
        // A grant the Team already holds answers 200, and the store writes no row for it. Two first links at once may
        // both answer 201, while the store still writes one row.
        const held = (await writeGrants.list(team)).some(
          (grant) => grant.installationId === installationId,
        );
        const grant = await writeGrants.grant(team, {
          installationId,
          grantedBy: c.get("session").userId,
        });
        return c.json(writeGrantBody(grant) satisfies WriteGrantBody, held ? 200 : 201);
      } catch (error) {
        if (error instanceof GitHubRefusedCode) {
          return c.json({ error: "GitHub refused the sign-in; connect again" }, 400);
        }
        if (error instanceof GitHubInstallationUnreachable) {
          return c.json(
            { error: "The app can't reach this installation on GitHub; nothing was linked" },
            409,
          );
        }
        if (error instanceof InstallationLinkedElsewhere) {
          // The store's own message is about the read app's link, so it isn't answered.
          return c.json({ error: "This write installation is linked to another Team" }, 409);
        }
        if (error instanceof GitHubUnavailable) {
          // The step and status only: GitHub's own words in the message aren't repeated.
          logger.error("GitHub didn't answer; nothing was linked", {
            team,
            step: error.step,
            status: error.status,
          });
          return c.json({ error: "GitHub didn't answer; nothing was linked" }, 502);
        }
        throw error;
      }
    });
  };
}
