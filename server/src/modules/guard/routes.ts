// Guard's own routes, mounted by the app through `moduleRoutes` (ADR 0005: the app imports no module). The Team is
// always the session's, never the request's.
import {
  assetKey,
  MAX_SCAN_ASSETS,
  type Asset,
  type LinkedInstallationBody,
  type RepoAssetBody,
  type ReposBody,
  type ScanBody,
} from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import type { Logger } from "../../log.ts";
import { startScan, type ScanJobStarter, type Scans } from "../../scans.ts";
import { DEFAULT_PACK_RULE_IDS } from "./default-pack.ts";
import {
  gitHubAppRoute,
  gitHubLinkRoute,
  permissionsMatch,
  type GitHubClient,
} from "./github-link.ts";
import type { RepoAsset, RepoAssets } from "./repo-assets.ts";

/** The read-only app's permissions (threat G1): an installation token holding anything else isn't linked. */
const READ_ONLY: Record<string, string> = { contents: "read", metadata: "read" };

/** Fails closed: a token naming no permissions isn't read-only, since what it can do isn't known. */
function isReadOnly(permissions: Record<string, string>) {
  return permissionsMatch(READ_ONLY, permissions, { exact: false });
}

const NOT_SET_UP = "GitHub isn't set up here";

function repoAssetBody(repo: RepoAsset): RepoAssetBody {
  return {
    asset: { kind: "repo", ref: repo.ref },
    installation_id: repo.installationId,
    listed_at: repo.listedAt.toISOString(),
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
  } & GitHubClient,
): MountRoutes {
  const { repoAssets, now = Date.now } = deps;
  const answerApp = gitHubAppRoute("read", deps, NOT_SET_UP, now);

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

  // An Admin links a GitHub installation to the session's Team (stories 1 and 15): GitHub confirms, with the person's
  // own sign-in, that they can reach it, and only the repos they can read in it become Repo Assets. The App's token
  // must be read-only. Every refusal writes nothing.
  const linkReadApp = gitHubLinkRoute({
    app: "read",
    client: deps,
    notSetUp: NOT_SET_UP,
    permitted: isReadOnly,
    notPermitted: "This installation can do more than read",
    linkedElsewhere: "This installation is linked to another Team",
    // What this link wrote: a later link of another installation can't change this answer.
    link: ({ team, installationId, linkedBy, repos }) =>
      repoAssets.link(team, { installationId, linkedBy, repos }),
    answer: async (c, linked, { team, installationId, linkedBy, logger }) =>
      c.json(
        {
          installation_id: installationId,
          repos: linked.map(repoAssetBody),
          // The 201 waits for the Scan Job to start: on Cloud Run, a token call and a run call of up to 10 s each, so
          // a slow start holds the link's answer for up to about 20 s. The link is written either way.
          scan: await firstScan(team, linked, linkedBy, logger),
        } satisfies LinkedInstallationBody,
        201,
      ),
  });

  return (app, requireRole) => {
    // What an Admin's Setup page builds GitHub's install and sign-in links from (story 1).
    app.get("/api/github/app", requireRole("admin"), answerApp);

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

    app.post("/api/github/installations", requireRole("admin"), linkReadApp);
  };
}
