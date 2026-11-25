// Guard's scanner (Guard spec, stories 3, 4 and 15): reads each of a Scan's repos through the RepoReader and reports
// what the Default Pack's Rules find in its files. A repo it can't read fails the whole Scan, so nothing is reconciled:
// a partial Scan would mark the unread repo's Findings Fixed. A file whose path a Finding's Location can't hold (too
// long, a `\`, a drive letter) is skipped rather than failing the Scan. A file the reader couldn't read as text (too
// large, binary, not UTF-8) is reported unread, so its Findings stay as they are. The log gets counts only, never a
// path, a file's text or a match.
import { assetKey, Location } from "@warden/contracts";
import type { Logger } from "../../log.ts";
import type { Scanner } from "../../scans.ts";
import { DEFAULT_PACK } from "./default-pack.ts";
import type { RepoAssets } from "./repo-assets.ts";
import type { RepoReader } from "./repo-reader.ts";
import { secretObservations } from "./secrets.ts";

/** What a Guard Scan throws with no RepoReader: the Job hasn't been given GitHub's settings. */
export const NO_READER = "GitHub isn't set up for the Scan Job";

export function guardScanner({
  repoAssets,
  reader,
  logger,
}: {
  repoAssets: Pick<RepoAssets, "list" | "outside">;
  /** None where nothing is scanned (the server reads only the Rules), or where GitHub isn't set up: a Scan fails. */
  reader?: RepoReader;
  logger: Logger;
}): Scanner {
  return {
    rules: DEFAULT_PACK.map((rule) => rule.ruleId),

    async held(team, assets) {
      const outside = new Set((await repoAssets.outside(team, assets)).map(assetKey));
      return assets.filter((asset) => !outside.has(assetKey(asset)));
    },

    async scan({ team, assets, rules }, recorder) {
      if (reader === undefined) throw new Error(NO_READER);
      const held = new Map((await repoAssets.list(team)).map((repo) => [repo.ref, repo]));
      const covered = new Set<string>(rules);
      for (const asset of assets) {
        const repo = asset.kind === "repo" ? held.get(asset.ref) : undefined;
        if (repo === undefined) throw new Error(`${asset.ref} isn't one of the Team's repos`);
        let files = 0;
        let skipped = 0;
        let unread = 0;
        let observations = 0;
        for await (const file of reader.readRepo(repo.installationId, {
          ref: repo.ref,
          githubId: repo.githubId,
        })) {
          files += 1;
          if (!Location.safeParse({ kind: "file", path: file.path }).success) {
            skipped += 1;
            continue;
          }
          if (!("text" in file)) {
            // Its text is unknown, so the Findings in it stay as they are rather than being marked Fixed.
            recorder.unread(asset, file.path);
            unread += 1;
            continue;
          }
          for (const observation of secretObservations(asset, file)) {
            if (!covered.has(observation.rule_id)) continue;
            recorder.saw(observation);
            observations += 1;
          }
        }
        logger.info("guard scan: repo read", {
          team,
          repo: asset.ref,
          files,
          skipped,
          unread,
          observations,
        });
      }
    },
  };
}
