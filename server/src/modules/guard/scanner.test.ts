// Guard's scanner over a fake RepoReader and recorder (Guard spec, stories 3 and 4): which file paths reach the
// other-AI-tool Rule, and the Scan's Rules filter on what it reports.
import type { Asset, Observation, RuleId } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import type { ScanRecorder } from "../../findings/index.ts";
import { createLogger } from "../../log.ts";
import { DEFAULT_PACK_RULE_IDS } from "./default-pack.ts";
import type { RepoFile, RepoReader, UnreadFile } from "./repo-reader.ts";
import { guardScanner } from "./scanner.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };
const RULE = "guard/unapproved-ai-tool";

/** Scans the repo, whose files are `files`, for `rules`; answers what the recorder was given. */
async function scan(files: (RepoFile | UnreadFile)[], rules: readonly RuleId[]) {
  const reader: RepoReader = {
    async *readRepo() {
      yield* files;
    },
  };
  const scanner = guardScanner({
    repoAssets: {
      list: async () => [{ ref: repo.ref, githubId: 1, installationId: 2, listedAt: new Date() }],
      outside: async () => [],
    },
    reader,
    logger: createLogger(() => {}),
  });
  const saw: Observation[] = [];
  const unread: string[] = [];
  const recorder: ScanRecorder = {
    saw: (observation) => saw.push(observation),
    unread: (_, path) => unread.push(path),
  };
  await scanner.scan({ team: "org_scanner", assets: [repo], rules: [...rules] }, recorder);
  return { saw, unread };
}

const ofRule = (saw: readonly Observation[]) => saw.filter(({ rule_id }) => rule_id === RULE);

describe("guardScanner and the other-AI-tool Rule", () => {
  it("reports the Windsurf Observation for a file under .windsurf/ it couldn't read, and the file as unread", async () => {
    const { saw, unread } = await scan(
      [{ path: ".windsurf/workflows/large.bin", unread: true }],
      DEFAULT_PACK_RULE_IDS,
    );

    expect(ofRule(saw).map(({ location }) => location)).toEqual([
      { kind: "file", path: ".windsurf" },
    ]);
    expect(unread).toEqual([".windsurf/workflows/large.bin"]);
  });

  it("reports a .cursorrules for a Scan with the Rule, and nothing for one queued without it", async () => {
    const files: RepoFile[] = [{ path: ".cursorrules", text: "Always use tabs.\n" }];
    const without = DEFAULT_PACK_RULE_IDS.filter((rule) => rule !== RULE);

    expect(ofRule((await scan(files, DEFAULT_PACK_RULE_IDS)).saw)).toHaveLength(1);
    expect((await scan(files, without)).saw).toEqual([]);
  });

  it("skips a path no Location can hold, as it skips the file", async () => {
    const { saw } = await scan(
      [{ path: `${"a".repeat(1100)}/.cursorrules`, text: "Always use tabs.\n" }],
      DEFAULT_PACK_RULE_IDS,
    );

    expect(saw).toEqual([]);
  });
});
