// Guard's own routes, mounted by the app through `moduleRoutes` (ADR 0005: the app imports no module). The Team is
// always the session's, never the request's.
import {
  LinkInstallationBody,
  type GitHubAppBody,
  type LinkedInstallationBody,
  type RepoAssetBody,
  type ReposBody,
} from "@warden/contracts";
import type { z } from "zod";
import type { MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import type { Logger } from "../../log.ts";
import { SCANS_PER_HOUR } from "../../scans.ts";
import {
  GitHubInstallationUnreachable,
  GitHubRefusedCode,
  GitHubUnavailable,
  type GitHub,
} from "./github.ts";
import { InstallationLinkedElsewhere, type RepoAsset, type RepoAssets } from "./repo-assets.ts";

/** Link attempts a Team may make in an hour: the number of Scans it may start. */
const LINKS_PER_HOUR = SCANS_PER_HOUR;

/** The read-only app's permissions (threat G1): an installation token holding anything else isn't linked. */
const READ_ONLY: Record<string, string> = { contents: "read", metadata: "read" };

/** Fails closed: a token naming no permissions isn't read-only, since what it can do isn't known. */
function isReadOnly(permissions: Record<string, string>) {
  const named = Object.entries(permissions);
  return named.length > 0 && named.every(([name, level]) => READ_ONLY[name] === level);
}

/** A body a schema refused, as one line, worded as the app's own routes word it: each issue's field and message. */
function refusedBody(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function repoAssetBody(repo: RepoAsset): RepoAssetBody {
  return {
    asset: { kind: "repo", ref: repo.ref },
    installation_id: repo.installationId,
    listed_at: repo.listedAt.toISOString(),
  };
}

/** Guard's routes; linking needs `github`, which comes with the logger its failures are written to. */
export function guardRoutes(
  deps: { repoAssets: RepoAssets } & (
    { github: GitHub; logger: Logger } | { github?: undefined; logger?: Logger }
  ),
): MountRoutes {
  const { repoAssets } = deps;
  // Kept in this instance's memory, keyed by Team id as it is: each Cloud Run instance counts on its own (threat A5).
  const linkLimit = createAttemptLimit({ max: LINKS_PER_HOUR, windowMs: 3_600_000 });
  // The App's slug, read from GitHub once and kept for this instance's life. A read that fails isn't kept, so the next
  // call asks again; calls while a read runs share it.
  let slug: Promise<string> | undefined;

  return (app, requireRole) => {
    // What an Admin's Setup page builds GitHub's install and sign-in links from (story 1).
    app.get("/api/github/app", requireRole("admin"), async (c) => {
      if (deps.github === undefined) return c.json({ error: "GitHub isn't set up here" }, 503);
      const { github, logger } = deps;
      slug ??= github.appSlug().catch((error: unknown) => {
        slug = undefined;
        throw error;
      });
      try {
        return c.json({ slug: await slug, client_id: github.clientId } satisfies GitHubAppBody);
      } catch (error) {
        if (!(error instanceof GitHubUnavailable)) throw error;
        // The step and status only, as the link logs them.
        logger.error("GitHub didn't answer", {
          team: c.get("team"),
          step: error.step,
          status: error.status,
        });
        return c.json({ error: "GitHub didn't answer" }, 502);
      }
    });

    // Any person in the Team reads its Repo Assets, by ref (story 1).
    app.get("/api/repos", requireRole("member"), async (c) => {
      const repos = await repoAssets.list(c.get("team"));
      return c.json({ repos: repos.map(repoAssetBody) } satisfies ReposBody);
    });

    // An Admin links a GitHub installation to the session's Team (stories 1 and 15): GitHub confirms, with the person's
    // own sign-in, that they can reach it, and only the repos they can read in it become Repo Assets. The App's token
    // must be read-only. Every refusal writes nothing.
    app.post("/api/github/installations", requireRole("admin"), async (c) => {
      if (deps.github === undefined) return c.json({ error: "GitHub isn't set up here" }, 503);
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
      let linked: RepoAsset[];
      try {
        const repos = await github.userInstallationRepos(code, codeVerifier, installationId);
        if (repos === undefined) {
          return c.json({ error: "You can't reach this installation on GitHub" }, 403);
        }
        if (!isReadOnly(await github.installationPermissions(installationId))) {
          return c.json({ error: "This installation can do more than read" }, 409);
        }
        // What this link wrote: a later link of another installation can't change this answer.
        linked = await repoAssets.link(team, {
          installationId,
          linkedBy: c.get("session").userId,
          repos,
        });
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
          return c.json({ error: "This installation is linked to another Team" }, 409);
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

      return c.json(
        {
          installation_id: installationId,
          repos: linked.map(repoAssetBody),
        } satisfies LinkedInstallationBody,
        201,
      );
    });
  };
}
