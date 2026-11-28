// The Judge eval's run (spec #225, slice 10b): `pnpm --filter @warden/server eval:judge`, which sets WARDEN_EVAL=1;
// without it, this file skips, so the server's own test run never calls a model. The variables it reads are those
// `readEvalSettings` names; it prints the score table at the end, and fails when the paid cap stopped it.
import { describe, inject, it } from "vitest";
import { createWithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { loadEvalCases, loadEvalTargets } from "./judge-eval/eval-cases.ts";
import { runEval } from "./judge-eval/harness.ts";
import { scoreResults, scoreTable } from "./judge-eval/score.ts";
import { readEvalSettings } from "./judge-eval/settings.ts";

/** A run of every case on a slow local model takes hours. */
const RUN_TIMEOUT_MS = 24 * 60 * 60_000;

describe.skipIf(process.env.WARDEN_EVAL !== "1")("the Judge eval", () => {
  it(
    "replays each case through the hook to a local Warden, judges, saves and scores it",
    async () => {
      const cases = loadEvalCases();
      const settings = readEvalSettings(
        process.env,
        cases.map(({ name }) => name),
      );
      const pool = poolAs("warden_app", inject("testDatabase"));
      try {
        const run = await runEval({ settings, cases, withTeam: createWithTeam(pool) });
        console.log(scoreTable(scoreResults(run.results, loadEvalTargets())));
        if (run.capped !== undefined) throw new Error(run.capped.message);
      } finally {
        await pool.end();
      }
    },
    RUN_TIMEOUT_MS,
  );
});
