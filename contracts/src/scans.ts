// A Scan someone starts (ADR 0009), as the API takes and answers it: queued under the session's Team, then run by the
// Scan Job, which moves its state. The Team and who asked come from the session, never the body, and aren't answered.
import { z } from "zod";
import { Asset, assetKey, DateTime, Id, Module, RuleId } from "./finding.ts";

/** Where a queued Scan is: waiting for the Job, being run by it, or ended either way. */
export const ScanState = z.enum(["queued", "running", "done", "failed"]);
export type ScanState = z.infer<typeof ScanState>;

/** The most Assets one start may name. */
export const MAX_SCAN_ASSETS = 100;

/**
 * `POST /api/scans`: the module and the Assets to scan, 1 to 100, each listed once, never an Agent session (as `Scan`
 * refuses). The Rules are the module's scanner's, so the body doesn't name them.
 */
export const StartScanBody = z
  .strictObject({
    module: Module,
    assets: z.array(Asset).min(1).max(MAX_SCAN_ASSETS),
  })
  .superRefine((body, ctx) => {
    const seen = new Map<string, number>();
    body.assets.forEach((asset, i) => {
      if (asset.kind === "agent_session") {
        ctx.addIssue({
          code: "custom",
          path: ["assets", i],
          message: "an Agent session is never rescanned: only a Spot run reports on one",
        });
      }
      const earlier = seen.get(assetKey(asset));
      if (earlier !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", i],
          message: `the same Asset as assets[${earlier}]: each is listed once`,
        });
      } else {
        seen.set(assetKey(asset), i);
      }
    });
  });
export type StartScanBody = z.infer<typeof StartScanBody>;

/** `POST /api/scans` (202) and `GET /api/scans/:id`: one queued Scan and where it is. Each time is null until reached. */
export const ScanBody = z.strictObject({
  id: Id,
  module: Module,
  state: ScanState,
  assets: z.array(Asset),
  rules: z.array(RuleId),
  queued_at: DateTime,
  /** When the Job first started running it; a retried run keeps it, and reconciles under it. */
  started_at: DateTime.nullable(),
  /** When it was last done or failed. */
  ended_at: DateTime.nullable(),
});
export type ScanBody = z.infer<typeof ScanBody>;
