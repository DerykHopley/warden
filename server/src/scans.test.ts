// `startScan`'s outcome when the failed start can't be recorded: the queued Scan is answered, and the log holds why the
// start failed before why the move did. Fake Scans and starter, no database: the routes' own tests cover the rest.
import type { ScanBody } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.ts";
import { startScan, type Scans } from "./scans.ts";

const TEAM = "org_start";

const queuedScan: ScanBody = {
  id: "the-scan-id",
  module: "guard",
  state: "queued",
  assets: [{ kind: "repo", ref: "https://github.com/example/app" }],
  rules: ["guard/secret-in-repo"],
  queued_at: "2026-11-25T09:00:00.000Z",
  started_at: null,
  ended_at: null,
};

const START_FAILED = "The Scan Job couldn't be started; marking the Scan failed";
const MOVE_FAILED = "The Scan couldn't be marked failed; it stays queued";

describe("startScan", () => {
  it.each([
    [
      "throws",
      () => Promise.reject(new Error("the database went away")),
      [START_FAILED, MOVE_FAILED],
    ],
    ["answers nothing", () => Promise.resolve(undefined), [START_FAILED]],
  ])(
    "gives start_failed with the queued Scan when the move to failed %s, logging the start error first",
    async (_name, move, errorMessages) => {
      const lines: string[] = [];
      const scans: Scans = {
        queue: async () => ({ kind: "queued", scan: queuedScan }),
        get: async () => undefined,
        move,
      };

      const outcome = await startScan(
        {
          scans,
          startScanJob: () => Promise.reject(new Error("the Job's host refused")),
          logger: createLogger((line) => lines.push(line)),
        },
        TEAM,
        {
          module: "guard",
          assets: queuedScan.assets,
          rules: queuedScan.rules,
          requestedBy: "user_lead",
        },
      );

      expect(outcome).toEqual({ kind: "start_failed", scan: queuedScan });
      const errors = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.severity === "ERROR");
      expect(errors.map((entry) => entry.message)).toEqual(errorMessages);
      for (const entry of errors) {
        expect(entry).toMatchObject({ team: TEAM, scanId: queuedScan.id });
      }
    },
  );
});
