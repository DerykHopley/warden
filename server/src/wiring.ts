// What each module hands the shared code (ADR 0005): its move rule and its scanner (and Guard's Judge, which the Scan
// Job runs for an ended Agent session), in one list the start-up files
// import (index.ts, scan-job.ts and seed.ts), so the server, the Scan Job and the demo seed can't drift apart. Besides
// index.ts and seed.ts, the one file outside the modules that may import them. Not a registry: a module is wired by
// its line here and never registers itself, so adding one adds a line to each list and changes no shared code.
import type { Module } from "@warden/contracts";
import { ConfigError, type GitHubReaderSettings, type JudgeSettings } from "./config.ts";
import { createFindings, type MoveRule } from "./findings/index.ts";
import type { Fetch } from "./http-call.ts";
import type { Logger } from "./log.ts";
import { createAgentSessions } from "./modules/guard/agent-sessions.ts";
import { createGitHubReader } from "./modules/guard/github-reader.ts";
import { createJudge, type Judge } from "./modules/guard/judge.ts";
import { openRouterModel, type JudgeModel } from "./modules/guard/judge-model.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { createRepoAssets } from "./modules/guard/repo-assets.ts";
import type { RepoReader } from "./modules/guard/repo-reader.ts";
import { guardScanner } from "./modules/guard/scanner.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import type { Scanners } from "./scans.ts";
import type { WithTeam } from "./with-team.ts";

/** Each module's move rule, as reconcile applies it. */
export const MOVE_RULES: Partial<Record<Module, MoveRule>> = {
  guard: guardMoveRule,
  patch: patchMoveRule,
};

/**
 * Each module's scanner. A start names its Rules, and the Scan Job runs it. It takes `withTeam` rather than the
 * modules' stores, as the Scan Job may not import a module to build them (ADR 0005). Guard reads repos through
 * `reader`: without one, a Guard Scan fails, and the server, which only reads the Rules, needs none.
 */
export function scanners({
  withTeam,
  reader,
  logger,
}: {
  withTeam: WithTeam;
  reader?: RepoReader;
  logger: Logger;
}): Scanners {
  return { guard: guardScanner({ repoAssets: createRepoAssets({ withTeam }), reader, logger }) };
}

/**
 * The RepoReader the Scan Job reads repos through on GitHub, built here as the Job may not import Guard (ADR 0005).
 * Tests hand it a fake `fetch`.
 */
export function gitHubRepoReader(
  settings: GitHubReaderSettings,
  logger: Logger,
  fetch?: Fetch,
): RepoReader {
  return createGitHubReader({ ...settings, logger, fetch });
}

export type { Judge, JudgeRunOutcome } from "./modules/guard/judge.ts";

/** A model that makes no call: its every call refuses the unset key, so a run with nothing to judge still exits 0. */
const noKeyModel: JudgeModel = {
  complete: () => Promise.reject(new ConfigError(["OPENROUTER_API_KEY"])),
};

/**
 * Guard's Judge, which the Scan Job runs for one ended Agent session, built here as the Job may not import Guard (ADR
 * 0005): the Agent sessions and Findings on `withTeam`, and the model on OpenRouter. With no key in `settings`, the
 * run throws ConfigError naming OPENROUTER_API_KEY before any call. Tests hand it a fake `fetch` and a short timeout.
 */
export function judge({
  withTeam,
  settings,
  fetch,
  timeoutMs,
}: {
  withTeam: WithTeam;
  settings: JudgeSettings;
  fetch?: Fetch;
  timeoutMs?: number;
}): Judge {
  return createJudge({
    agentSessions: createAgentSessions({ withTeam }),
    findings: createFindings({ withTeam, moveRules: MOVE_RULES }),
    model:
      settings.apiKey === undefined
        ? noKeyModel
        : openRouterModel({ apiKey: settings.apiKey, model: settings.model, fetch, timeoutMs }),
  });
}
