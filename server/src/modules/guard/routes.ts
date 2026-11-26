// Guard's own routes, mounted by the app through `moduleRoutes` (ADR 0005: the app imports no module). The Team is
// always the session's, never the request's.
import {
  assetKey,
  LinkInstallationBody,
  MAX_SCAN_ASSETS,
  type Asset,
  type GitHubAppBody,
  type LinkedInstallationBody,
  type RepoAssetBody,
  type ReposBody,
  type ScanBody,
} from "@warden/contracts";
import type { Context } from "hono";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import type { Logger } from "../../log.ts";
import { refusedBody } from "../../refused-body.ts";
import { SCANS_PER_HOUR, startScan, type ScanJobStarter, type Scans } from "../../scans.ts";
import { DEFAULT_PACK_RULE_IDS } from "./default-pack.ts";
import {
  GitHubInstallationUnreachable,
  GitHubRefusedCode,
  GitHubUnavailable,
  type GitHub,
} from "./github.ts";
import { InstallationLinkedElsewhere, type RepoAsset, type RepoAssets } from "./repo-assets.ts";

/** Link attempts a Team may make in an hour, per app: the number of Scans it may start. */
export const LINKS_PER_HOUR = SCANS_PER_HOUR;

/** The read-only app's permissions (threat G1): an installation token holding anything else isn't linked. */
const READ_ONLY: Record<string, string> = { contents: "read", metadata: "read" };

/** Fails closed: a token naming no permissions isn't read-only, since what it can do isn't known. */
function isReadOnly(permissions: Record<string, string>) {
  const named = Object.entries(permissions);
  return named.length > 0 && named.every(([name, level]) => READ_ONLY[name] === level);
}

function repoAssetBody(repo: RepoAsset): RepoAssetBody {
  return {
    asset: { kind: "repo", ref: repo.ref },
    installation_id: repo.installationId,
    listed_at: repo.listedAt.toISOString(),
  };
}

/** How long the App's slug is kept before GitHub is asked again, so a renamed App's links follow within the hour. */
const SLUG_KEPT_MS = 3_600_000;

/**
 * A handler answering `github`'s GitHubAppBody, what a Setup page builds GitHub's install and sign-in links from. The
 * slug is read from GitHub and kept for an hour from when the read began, by `now`; a read that fails isn't kept, so the
 * next call asks again, and calls while a read runs share it. GitHub not answering is 502, logged with the step and
 * status only. Each app's route builds its own, so each keeps its own slug.
 */
export function gitHubAppAnswer(github: GitHub, logger: Logger, now: () => number) {
  let slug: { read: Promise<string>; at: number } | undefined;
  return async (c: Context<AppEnv>) => {
    if (slug === undefined || now() - slug.at >= SLUG_KEPT_MS) {
      const reading = {
        at: now(),
        read: github.appSlug().catch((error: unknown) => {
          if (slug === reading) slug = undefined;
          throw error;
        }),
      };
      slug = reading;
    }
    try {
      return c.json({ slug: await slug.read, client_id: github.clientId } satisfies GitHubAppBody);
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
  };
}

/**
 * Guard's routes; linking needs `github`, which comes with the logger its failures are written to. `now` is the clock
 * the kept slug ages by. With `scans` and `startScanJob`, a link starts the first Scan of its repos.
 */
export function guardRoutes(
  deps: {
    repoAssets: RepoAssets;
    now?: () => number;
    scans?: Scans;
    startScanJob?: ScanJobStarter;
  } & ({ github: GitHub; logger: Logger } | { github?: undefined; logger?: Logger }),
): MountRoutes {
  const { repoAssets, now = Date.now } = deps;
  // Kept in this instance's memory, keyed by Team id as it is: each Cloud Run instance counts on its own (threat A5).
  const linkLimit = createAttemptLimit({ max: LINKS_PER_HOUR, windowMs: 3_600_000 });
  const answerApp = deps.github ? gitHubAppAnswer(deps.github, deps.logger, now) : undefined;

  /**
   * The first Scan of a link's repos (story 2): a Guard Scan of the first MAX_SCAN_ASSETS by ref, with the Default
   * Pack's Rules, as the linking Admin. Null when it starts none: no repos, no Scans or starter here, or the Team at
   * its hourly Scan limit. The link is already written, so a Scan that can't be queued is logged, never refused.
   */
  async function firstScan(
    team: string,
    linked: readonly RepoAsset[],
    requestedBy: string,
    logger: Logger,
  ): Promise<ScanBody | null> {
    const { scans, startScanJob } = deps;
    if (linked.length === 0 || scans === undefined || startScanJob === undefined) return null;
    const assets = linked
      .map((repo) => repo.ref)
      .sort()
      .slice(0, MAX_SCAN_ASSETS)
      .map((ref): Asset => ({ kind: "repo", ref }));
    try {
      const outcome = await startScan({ scans, startScanJob, logger }, team, {
        module: "guard",
        assets,
        rules: [...DEFAULT_PACK_RULE_IDS],
        requestedBy,
      });
      return outcome.kind === "rate_limited" ? null : outcome.scan;
    } catch (error) {
      logger.error("The first Scan after a link couldn't be queued; the link stands", {
        team,
        error,
      });
      return null;
    }
  }

  return (app, requireRole) => {
    // What an Admin's Setup page builds GitHub's install and sign-in links from (story 1).
    app.get("/api/github/app", requireRole("admin"), (c) =>
      answerApp ? answerApp(c) : c.json({ error: "GitHub isn't set up here" }, 503),
    );

    // Any person in the Team reads its Repo Assets, by ref (story 1), each with its last Guard Scan (story 2): null
    // when no Scan names it, or with no `scans` here.
    app.get("/api/repos", requireRole("member"), async (c) => {
      const team = c.get("team");
      const repos = (await repoAssets.list(team)).map(repoAssetBody);
      const last = deps.scans
        ? await deps.scans.lastFor(
            team,
            "guard",
            repos.map((repo) => repo.asset),
          )
        : new Map<string, ScanBody>();
      return c.json({
        repos: repos.map((repo) => ({
          ...repo,
          last_scan: last.get(assetKey(repo.asset)) ?? null,
        })),
      } satisfies ReposBody);
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
          // The 201 waits for the Scan Job to start: on Cloud Run, a token call and a run call of up to 10 s each, so
          // a slow start holds the link's answer for up to about 20 s. The link is written either way.
          scan: await firstScan(team, linked, c.get("session").userId, logger),
        } satisfies LinkedInstallationBody,
        201,
      );
    });
  };
}
