// The demo data the seed writes and the dashboard's tests read: every run valid as the contracts take it.
import { describe, expect, it } from "vitest";
import {
  DEMO_EVENTS,
  DEMO_EVENTS_HASH,
  DEMO_OBSERVATIONS,
  DEMO_PRODUCT,
  DEMO_RUN_IDS,
  demoRuns,
} from "../src/demo.ts";
import { agentEventsHash, Observation, ProductInput, Scan, SpotRun } from "../src/index.ts";

describe("the demo data", () => {
  it("holds only valid Observations", () => {
    for (const [name, observation] of Object.entries(DEMO_OBSERVATIONS)) {
      expect(Observation.safeParse(observation).success, name).toBe(true);
    }
  });

  it("makes valid Scans and a valid Spot run, with the run ids it names, seeing every Observation", () => {
    const { scans, spotRun } = demoRuns("org_a", new Date("2026-11-24T12:00:00Z"));
    for (const scan of scans) Scan.parse(scan);
    SpotRun.parse(spotRun);
    expect([...scans.map((s) => s.id), spotRun.id].sort()).toEqual([...DEMO_RUN_IDS].sort());
    const seen = new Set([...scans, spotRun].flatMap((run) => run.observations));
    expect(seen).toEqual(new Set(Object.values(DEMO_OBSERVATIONS)));
  });

  it("gives the demo Product one Repo URL, the demo Repo Asset's ref", () => {
    expect(ProductInput.parse(DEMO_PRODUCT)).toEqual(DEMO_PRODUCT);
    const repos = new Set(
      Object.values(DEMO_OBSERVATIONS)
        .filter((o) => o.asset.kind === "repo")
        .map((o) => o.asset.ref),
    );
    expect([...repos]).toEqual(DEMO_PRODUCT.repo_urls);
  });

  it("keeps the Judge's events hash true to its events", async () => {
    expect(DEMO_EVENTS_HASH).toBe(await agentEventsHash(DEMO_EVENTS));
  });
});
