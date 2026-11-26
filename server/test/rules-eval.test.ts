// The rules eval (Guard spec, story 13): Guard's scanner, with the real Default Pack, over the Seeded org's labelled
// repos, scored per Rule. A label is a Finding a correct Scan opens, matched to an Observation by `problemKey` (Rule,
// repo and Location path; the line is left out, as the Fingerprint leaves it out). The eval prints a per-Rule table,
// then fails, naming each Rule, repo and path behind a miss, when any Rule's precision or recall is below 1. A case a
// Rule gets wrong is a bug for the spec: the Rule and the label stay as they are. Runs alone with
// `pnpm --filter @warden/server eval:rules`.
import { readFileSync } from "node:fs";
import { Observation, problemKey, type RuleId } from "@warden/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ScanRecorder } from "../src/findings/index.ts";
import { createLogger } from "../src/log.ts";
import {
  isClaudeCodePath,
  ROOT_SETTINGS,
  WHOLE_REPO_PATH,
} from "../src/modules/guard/agent-config.ts";
import { AI_TOOL_LOCATIONS } from "../src/modules/guard/ai-tools.ts";
import { DEFAULT_PACK_RULE_IDS, UNAPPROVED_AI_TOOL } from "../src/modules/guard/default-pack.ts";
import type { RepoFile, RepoReader } from "../src/modules/guard/repo-reader.ts";
import { guardScanner } from "../src/modules/guard/scanner.ts";
import { AWS_KEY } from "./secret-fixtures.ts";
import { PLANTED_SECRETS, SEEDED_ORG, type SeededRepo } from "./seeded-org.ts";

/** A labelled problem in one repo: a Finding a correct Scan opens. */
type Label = { repo: string; rule: RuleId; path: string };

/** Where a true positive, a false positive or a false negative sits. */
type Place = { repo: string; path: string };

/** One Rule's score over the labelled cases. */
type RuleScore = {
  rule: RuleId;
  labels: number;
  observations: number;
  /** The labels an Observation found. */
  truePositives: Place[];
  /** The Observations with no label. */
  falsePositives: Place[];
  /** The labels no Observation found. */
  falseNegatives: Place[];
  /** The Observations of a problem an earlier Observation already reported: each one lowers precision. */
  repeats: Place[];
  /** True positives over Observations; 1 for none. */
  precision: number;
  /** True positives over labels; 1 for none. */
  recall: number;
};

const keyOf = ({ repo, rule, path }: Label) =>
  problemKey({
    asset: { kind: "repo", ref: repo },
    rule_id: rule,
    location: { kind: "file", path },
  });

/** A share, with 0 of 0 as 1: a Rule that neither reports nor misses anything is right. */
const share = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);

/** Where an Observation sits: its repo, and its file's path, or its Location's kind in brackets when not a file. */
const placeOf = ({ asset, location }: Observation): Place => ({
  repo: asset.ref,
  path: location.kind === "file" ? location.path : `(${location.kind})`,
});

/**
 * Each Rule's score, for every Rule a label or an Observation names, in the order first named: labels found (true
 * positives), Observations with no label (false positives), labels not found (false negatives) and Observations of a
 * problem already reported (repeats).
 */
function scoreRules(labels: readonly Label[], observations: readonly Observation[]): RuleScore[] {
  const labelled = new Set(labels.map(keyOf));
  const observed = new Set(observations.map(problemKey));
  const rules = [
    ...new Set([...labels.map(({ rule }) => rule), ...observations.map(({ rule_id }) => rule_id)]),
  ];
  return rules.map((rule) => {
    const ruleLabels = labels.filter((label) => label.rule === rule);
    const ruleObservations = observations.filter(({ rule_id }) => rule_id === rule);
    const place = (label: Label): Place => ({ repo: label.repo, path: label.path });
    const truePositives = ruleLabels.filter((label) => observed.has(keyOf(label))).map(place);
    const falseNegatives = ruleLabels.filter((label) => !observed.has(keyOf(label))).map(place);
    const falsePositives = ruleObservations
      .filter((observation) => !labelled.has(problemKey(observation)))
      .map(placeOf);
    const repeats = ruleObservations
      .filter(
        (observation, i) =>
          ruleObservations.findIndex((earlier) => problemKey(earlier) === problemKey(observation)) <
          i,
      )
      .map(placeOf);
    return {
      rule,
      labels: ruleLabels.length,
      observations: ruleObservations.length,
      truePositives,
      falsePositives,
      falseNegatives,
      repeats,
      precision: share(truePositives.length, ruleObservations.length),
      recall: share(truePositives.length, ruleLabels.length),
    };
  });
}

/** One line per miss, naming its Rule, repo and path: what fails the eval. */
const misses = (scores: readonly RuleScore[]) =>
  scores.flatMap(({ rule, falseNegatives, falsePositives, repeats }) => [
    ...falseNegatives.map(({ repo, path }) => `${rule} missed the label in ${repo} at ${path}`),
    ...falsePositives.map(({ repo, path }) => `${rule} reported ${repo} at ${path}, with no label`),
    ...repeats.map(({ repo, path }) => `${rule} reported ${repo} at ${path} more than once`),
  ]);

/** The per-Rule table the eval prints, in the Default Pack's order. */
function table(scores: readonly RuleScore[]): string {
  const order = (rule: RuleId) => DEFAULT_PACK_RULE_IDS.indexOf(rule);
  const rows = [
    ["Rule", "labels", "Observations", "true positives", "precision", "recall"],
    ...scores
      .toSorted((a, b) => order(a.rule) - order(b.rule))
      .map((score) => [
        score.rule,
        String(score.labels),
        String(score.observations),
        String(score.truePositives.length),
        score.precision.toFixed(2),
        score.recall.toFixed(2),
      ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  "),
    )
    .join("\n");
}

type FixtureRepo = Pick<SeededRepo, "ref" | "files">;

/**
 * Scans `repos` with every Default Pack Rule through a fake RepoReader, as one Scan of them all, and answers each
 * Observation the recorder was given, parsed as Observation v1.
 */
async function scanRepos(repos: readonly FixtureRepo[]): Promise<Observation[]> {
  const files = new Map(repos.map((repo) => [repo.ref, repo.files]));
  const reader: RepoReader = {
    async *readRepo(_, { ref }) {
      const found = files.get(ref);
      if (found === undefined) throw new Error(`no seeded repo ${ref}`);
      yield* found;
    },
  };
  const scanner = guardScanner({
    repoAssets: {
      list: async () =>
        repos.map(({ ref }, i) => ({
          ref,
          githubId: i + 1,
          installationId: 1,
          listedAt: new Date(),
        })),
      outside: async () => [],
    },
    reader,
    logger: createLogger(() => {}),
  });
  const observations: Observation[] = [];
  const recorder: ScanRecorder = {
    saw: (observation) => observations.push(Observation.parse(observation)),
    unread: () => {},
  };
  await scanner.scan(
    {
      team: "org_seeded",
      assets: repos.map(({ ref }) => ({ kind: "repo", ref })),
      rules: [...DEFAULT_PACK_RULE_IDS],
    },
    recorder,
  );
  return observations;
}

const labelsOf = (repos: readonly SeededRepo[]): Label[] =>
  repos.flatMap(({ ref, labels }) => labels.map(({ rule, path }) => ({ repo: ref, rule, path })));

describe("the Seeded org", () => {
  it.each(DEFAULT_PACK_RULE_IDS)("has two labels for %s in different repos", (rule) => {
    const repos = new Set(
      labelsOf(SEEDED_ORG)
        .filter((label) => label.rule === rule)
        .map(({ repo }) => repo),
    );

    expect(repos.size).toBeGreaterThanOrEqual(2);
  });

  it.each(DEFAULT_PACK_RULE_IDS)(
    "has a repo with a near miss for %s and no label for it",
    (rule) => {
      const nearMisses = SEEDED_ORG.filter(
        ({ labels, nearMisses }) =>
          nearMisses.some((nearMiss) => nearMiss.rule === rule) &&
          !labels.some((label) => label.rule === rule),
      );

      expect(nearMisses.map(({ name }) => name)).not.toEqual([]);
    },
  );

  it("places each label and near miss on a path the repo holds, or a folder of one", () => {
    const strays = SEEDED_ORG.flatMap(({ name, files, labels, nearMisses }) =>
      [...labels, ...nearMisses]
        .filter(
          ({ rule, path }) =>
            !files.some((file) => file.path === path || file.path.startsWith(`${path}/`)) &&
            // A whole-repo Rule's label sits at the root settings file, which a repo with no settings doesn't hold.
            path !== WHOLE_REPO_PATH &&
            // An AI tool's label sits at the tool's fixed Location, which a repo with only its other paths doesn't hold.
            !(rule === UNAPPROVED_AI_TOOL && AI_TOOL_LOCATIONS.includes(path)),
        )
        .map(({ rule, path }) => `${name}: ${rule} at ${path}`),
    );

    expect(strays).toEqual([]);
  });

  it("has a repo with no label at all, and one with no Claude Code path", () => {
    expect(SEEDED_ORG.filter(({ labels }) => labels.length === 0)).not.toEqual([]);
    expect(
      SEEDED_ORG.filter(({ files }) => !files.some(({ path }) => isClaudeCodePath(path))),
    ).not.toEqual([]);
  });

  // A root settings file left unread holds back the whole-repo Rules, which the eval then doesn't measure.
  it("names each repo once, under the Seeded org, and leaves no root settings file unread", () => {
    expect(new Set(SEEDED_ORG.map(({ name }) => name)).size).toBe(SEEDED_ORG.length);
    expect(SEEDED_ORG.map(({ name, ref }) => [name, ref])).toEqual(
      SEEDED_ORG.map(({ name }) => [name, `https://github.com/warden-seeded-org/${name}`]),
    );
    const unreadSettings = SEEDED_ORG.flatMap(({ files }) =>
      files.filter((file) => "unread" in file && ROOT_SETTINGS.includes(file.path)),
    );
    expect(unreadSettings).toEqual([]);
  });
});

describe("the rules eval", () => {
  /** The Observations of one Scan of the whole Seeded org, which each test below reads. */
  let observations: Observation[] = [];
  beforeAll(async () => {
    observations = await scanRepos(SEEDED_ORG);
  });

  it("finds every label and nothing else, for every Default Pack Rule", () => {
    const scores = scoreRules(labelsOf(SEEDED_ORG), observations);

    console.log(`Rules eval over the Seeded org (${SEEDED_ORG.length} repos):\n${table(scores)}`);
    expect(scores.map(({ rule }) => rule).toSorted()).toEqual(DEFAULT_PACK_RULE_IDS.toSorted());
    expect(misses(scores)).toEqual([]);
  });

  it("finds the other AI tool behind a file under .cursor/ it couldn't read, at the folder", () => {
    const [repo] = SEEDED_ORG.filter(({ files }) =>
      files.some((file) => "unread" in file && file.path.startsWith(".cursor/")),
    );
    if (repo === undefined) throw new Error("no seeded repo holds an unread file under .cursor/");
    const scores = scoreRules(labelsOf(SEEDED_ORG), observations);

    expect(scores.find(({ rule }) => rule === UNAPPROVED_AI_TOOL)?.truePositives).toContainEqual({
      repo: repo.ref,
      path: ".cursor",
    });
  });

  it("puts no planted secret's value in any Observation", () => {
    const planted = SEEDED_ORG.flatMap(({ files }) =>
      PLANTED_SECRETS.filter((secret) =>
        files.some((file) => "text" in file && file.text.includes(secret)),
      ),
    );

    expect(new Set(planted)).toEqual(new Set(PLANTED_SECRETS));
    expect(observations).not.toEqual([]);
    const leaks = observations.flatMap((observation) =>
      PLANTED_SECRETS.filter((secret) => JSON.stringify(observation).includes(secret)).map(
        (secret) => `${observation.rule_id} in ${observation.asset.ref}: ${secret.slice(0, 4)}…`,
      ),
    );
    expect(leaks).toEqual([]);
  });

  it("finds nothing in its own files: Warden's source holds no whole secret or skip flag", async () => {
    const own = ["seeded-org.ts", "rules-eval.test.ts", "secret-fixtures.ts"].map(
      (name): RepoFile => ({
        path: `server/test/${name}`,
        text: readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
      }),
    );
    const ownObservations = await scanRepos([
      { ref: "https://github.com/example/warden", files: own },
    ]);

    expect(ownObservations).toEqual([]);
  });
});

describe("scoreRules", () => {
  const app = "https://github.com/example/app";
  const api = "https://github.com/example/api";
  const repos: FixtureRepo[] = [
    { ref: app, files: [{ path: ".cursorrules", text: "Always use tabs.\n" }] },
    { ref: api, files: [{ path: "deploy/run.sh", text: "#!/bin/sh\nexit 0\n" }] },
  ];
  const labels: Label[] = [
    // The label for app's .cursorrules is dropped, and one is added that no Rule finds.
    { repo: api, rule: "guard/permission-skip", path: "deploy/run.sh" },
  ];

  it("names the Rule, the repo and the path of a missed label and of an Observation with no label", async () => {
    const observations = await scanRepos(repos);
    const scores = scoreRules(labels, observations);

    expect(misses(scores)).toEqual([
      `guard/permission-skip missed the label in ${api} at deploy/run.sh`,
      `guard/unapproved-ai-tool reported ${app} at .cursor, with no label`,
    ]);
    expect(
      scores.map(({ rule, labels, observations, truePositives, precision, recall }) => ({
        rule,
        labels,
        observations,
        found: truePositives.length,
        precision,
        recall,
      })),
    ).toEqual([
      {
        rule: "guard/permission-skip",
        labels: 1,
        observations: 0,
        found: 0,
        precision: 1,
        recall: 0,
      },
      {
        rule: "guard/unapproved-ai-tool",
        labels: 0,
        observations: 1,
        found: 0,
        precision: 0,
        recall: 1,
      },
    ]);
  });

  it("matches a label to an Observation on any line of its file, scoring 1 and 1", async () => {
    const file = { path: "src/aws.ts", text: `// AWS\n\nexport const key = "${AWS_KEY}";\n` };
    const observations = await scanRepos([{ ref: app, files: [file] }]);

    expect(
      scoreRules([{ repo: app, rule: "guard/secret-in-repo", path: "src/aws.ts" }], observations),
    ).toEqual([
      {
        rule: "guard/secret-in-repo",
        labels: 1,
        observations: 1,
        truePositives: [{ repo: app, path: "src/aws.ts" }],
        falsePositives: [],
        falseNegatives: [],
        repeats: [],
        precision: 1,
        recall: 1,
      },
    ]);
  });

  it("names a Rule that reports one labelled problem twice, on two lines of its file", async () => {
    const file = { path: "src/aws.ts", text: `// AWS\n\nexport const key = "${AWS_KEY}";\n` };
    const observations = await scanRepos([{ ref: app, files: [file] }]);
    const [first] = observations;
    if (first === undefined) throw new Error("no Observation for the planted key");
    const twice = [
      first,
      { ...first, location: { kind: "file" as const, path: "src/aws.ts", line: 5 } },
    ];
    const scores = scoreRules(
      [{ repo: app, rule: "guard/secret-in-repo", path: "src/aws.ts" }],
      twice,
    );

    expect(scores.map(({ precision }) => precision)).toEqual([0.5]);
    expect(misses(scores)).toEqual([
      `guard/secret-in-repo reported ${app} at src/aws.ts more than once`,
    ]);
  });
});
