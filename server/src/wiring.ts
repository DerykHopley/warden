// What each module hands the shared code (ADR 0005): its move rule and its scanner, in one list the start-up files
// import (index.ts, scan-job.ts and seed.ts), so the server, the Scan Job and the demo seed can't drift apart. Besides
// index.ts and seed.ts, the one file outside the modules that may import them. Not a registry: a module is wired by
// its line here and never registers itself, so adding one adds a line to each list and changes no shared code.
import type { Module } from "@warden/contracts";
import type { MoveRule } from "./findings/index.ts";
import { guardMoveRule } from "./modules/guard/move-rule.ts";
import { patchMoveRule } from "./modules/patch/move-rule.ts";
import type { Scanners } from "./scans.ts";

/** Each module's move rule, as reconcile applies it. */
export const MOVE_RULES: Partial<Record<Module, MoveRule>> = {
  guard: guardMoveRule,
  patch: patchMoveRule,
};

/** Each module's scanner: none yet. A start names its Rules, and the Scan Job runs it. */
export const SCANNERS: Scanners = {};
