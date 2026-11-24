// Run with: node --test spikes/long-work/src/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveries, parseScan, runTicks, secretReport } from "./work.ts";

test("parseScan takes a stand-in Scan with an id, a Team and a length in seconds", () => {
  assert.deepEqual(parseScan({ scanId: "scan-1", team: "team-a", seconds: 300 }), {
    scanId: "scan-1",
    team: "team-a",
    seconds: 300,
    failFirstDelivery: false,
    failFirstAttempt: false,
  });
});

test("parseScan refuses a Scan with no Team (ADR 0006: a job with no Team is refused)", () => {
  assert.throws(() => parseScan({ scanId: "scan-1", seconds: 10 }), /no Team/);
  assert.throws(() => parseScan({ scanId: "scan-1", team: "", seconds: 10 }), /no Team/);
});

test("parseScan refuses a Scan with no id or a bad length", () => {
  assert.throws(() => parseScan({ team: "team-a", seconds: 10 }), /no Scan id/);
  assert.throws(() => parseScan({ scanId: "s", team: "team-a", seconds: -1 }), /seconds/);
  assert.throws(() => parseScan("not an object"), /not an object/);
});

test("secretReport says found and a length, never the value", () => {
  const report = secretReport("abc123secretvalue");
  assert.equal(report, "secret found, length 17");
  assert.ok(!report.includes("abc123secretvalue"));
  assert.equal(secretReport(undefined), "secret missing");
  assert.equal(secretReport(""), "secret missing");
});

test("deliveries answer 500 to the first delivery of a Scan id and 200 to the next", () => {
  const deliveries = createDeliveries();
  assert.equal(deliveries.decide("scan-1"), 500);
  assert.equal(deliveries.decide("scan-1"), 200);
  assert.equal(deliveries.decide("scan-1"), 200);
  assert.equal(deliveries.decide("scan-2"), 500);
});

test("runTicks logs a numbered tick every interval with the gap since the last one", async () => {
  const lines: Record<string, unknown>[] = [];
  const scan = parseScan({ scanId: "scan-1", team: "team-a", seconds: 0.05 });
  await runTicks(scan, { intervalMs: 10, log: (fields) => lines.push(fields) });
  const ticks = lines.filter((line) => line.message === "tick");
  assert.ok(ticks.length >= 4, `expected about 5 ticks, got ${ticks.length}`);
  assert.equal(ticks[0].tick, 1);
  assert.equal(ticks[0].scanId, "scan-1");
  assert.equal(ticks[0].team, "team-a");
  assert.equal(typeof ticks[0].gapMs, "number");
  assert.equal(lines[0].message, "work started");
  assert.equal(lines.at(-1)?.message, "work finished");
});
