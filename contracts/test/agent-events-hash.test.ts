import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentEventsHash, type MaskedAgentEvent } from "../src/index.ts";
import { maskedEvent } from "./fixtures.ts";

/** The README's worked example: its events (the first json block under the heading) and the hash it states. */
function readmeExample(): { events: MaskedAgentEvent[]; hash: string } {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("### Worked example")[1];
  if (!section) throw new Error("README.md has no '### Worked example' section");
  const json = /```json\n([\s\S]*?)```/.exec(section)?.[1];
  const hash = /sha256:[0-9a-f]{64}/.exec(section)?.[0];
  if (!json || !hash)
    throw new Error("README.md's worked example needs a json block and a sha256: hash");
  return { events: JSON.parse(json) as MaskedAgentEvent[], hash };
}

describe("agentEventsHash()", () => {
  it("gives the README's worked example's hash for its events", async () => {
    const { events, hash } = readmeExample();
    expect(await agentEventsHash(events)).toBe(hash);
  });

  it("hashes the canonical form: compact JSON in a fixed key order, joined with newlines, SHA-256", async () => {
    // Keys given out of order, and one event without a tool: the canonical form fixes both.
    const events = [
      { text: "Fix the login test", name: "UserPromptSubmit", at: "2026-11-24T09:15:02Z", seq: 0 },
      { tool: "Bash", text: "cat .env", seq: 1, name: "PreToolUse", at: "2026-11-24T09:15:09Z" },
    ];
    const canonical =
      '{"seq":0,"at":"2026-11-24T09:15:02Z","name":"UserPromptSubmit","text":"Fix the login test"}\n' +
      '{"seq":1,"at":"2026-11-24T09:15:09Z","name":"PreToolUse","tool":"Bash","text":"cat .env"}';
    const expected = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    expect(await agentEventsHash(events)).toBe(expected);
  });

  it("gives a different hash for a changed text, a dropped event or a swapped order", async () => {
    const events = [maskedEvent(0), maskedEvent(1), maskedEvent(2)];
    const base = await agentEventsHash(events);
    expect(
      await agentEventsHash([maskedEvent(0), maskedEvent(1, { text: "step 1." }), maskedEvent(2)]),
    ).not.toBe(base);
    expect(await agentEventsHash([maskedEvent(0), maskedEvent(2)])).not.toBe(base);
    expect(await agentEventsHash([maskedEvent(1), maskedEvent(0), maskedEvent(2)])).not.toBe(base);
  });

  it("refuses an empty list", async () => {
    await expect(agentEventsHash([])).rejects.toThrow();
  });

  it("refuses an event MaskedAgentEvent refuses, so it never hashes a raw event", async () => {
    const raw = { ...maskedEvent(0), raw: "AWS_SECRET_ACCESS_KEY=abc" } as MaskedAgentEvent;
    await expect(agentEventsHash([raw])).rejects.toThrow(/raw/);
    const long = maskedEvent(0, { text: "x".repeat(4001) });
    await expect(agentEventsHash([long])).rejects.toThrow(/text/);
  });
});
