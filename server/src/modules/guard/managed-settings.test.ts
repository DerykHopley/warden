// The managed-settings block an Admin pastes into Claude Code (story 7): its events follow the Privacy tier, and every
// hook is the same `http` handler, the token in a header and never in a URL. Shapes from Claude Code's hooks reference.
import { HOOK_TOKEN_PLACEHOLDER } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { HOOK_EVENTS_PATH, managedSettings, type ManagedSettings } from "./managed-settings.ts";

const URL_BASE = "https://warden.example";
const TOKEN = "org_a.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const EVERY_TIER = ["SessionStart", "PostToolUse", "PostToolUseFailure", "SessionEnd"];

/** Every hook handler in the block, with the event it's under. */
const handlers = (block: ManagedSettings) =>
  Object.entries(block.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, hook }))),
  );

describe("managedSettings: the events follow the Privacy tier", () => {
  it.each(["metadata", "details"] as const)(
    "at %s holds the four session and tool events, and no UserPromptSubmit",
    (tier) => {
      const block = managedSettings({ url: URL_BASE, token: TOKEN, tier });

      expect(Object.keys(block.hooks).sort()).toEqual([...EVERY_TIER].sort());
    },
  );

  it("at content adds UserPromptSubmit", () => {
    const block = managedSettings({ url: URL_BASE, token: TOKEN, tier: "content" });

    expect(Object.keys(block.hooks).sort()).toEqual([...EVERY_TIER, "UserPromptSubmit"].sort());
  });
});

describe("managedSettings: every hook is the same http handler", () => {
  it.each(["metadata", "details", "content"] as const)(
    "at %s: http, the events URL, 5 s, USER allowed, the token only in Authorization",
    (tier) => {
      const block = managedSettings({ url: URL_BASE, token: TOKEN, tier });

      const all = handlers(block);
      expect(all.length).toBe(Object.keys(block.hooks).length);
      for (const { hook } of all) {
        expect(hook).toEqual({
          type: "http",
          url: `${URL_BASE}${HOOK_EVENTS_PATH}`,
          timeout: 5,
          allowedEnvVars: ["USER"],
          headers: { Authorization: `Bearer ${TOKEN}`, "X-Warden-Developer": "$USER" },
        });
      }
    },
  );

  it("matches every tool on the tool events", () => {
    const block = managedSettings({ url: URL_BASE, token: TOKEN, tier: "details" });

    expect(block.hooks.PostToolUse?.map((group) => group.matcher)).toEqual(["*"]);
    expect(block.hooks.PostToolUseFailure?.map((group) => group.matcher)).toEqual(["*"]);
  });

  it("holds no other setting: no allowManagedHooksOnly, no httpHookAllowedEnvVars", () => {
    const block = managedSettings({ url: URL_BASE, token: TOKEN, tier: "content" });

    expect(Object.keys(block)).toEqual(["hooks"]);
    expect(JSON.stringify(block)).not.toMatch(/allowManagedHooksOnly|httpHookAllowedEnvVars/);
  });

  it("names the events path on Warden's origin, whatever path the given URL has", () => {
    const block = managedSettings({
      url: "http://127.0.0.1:8787/somewhere/else",
      token: TOKEN,
      tier: "metadata",
    });

    for (const { hook } of handlers(block)) {
      expect(hook.url).toBe(`http://127.0.0.1:8787${HOOK_EVENTS_PATH}`);
    }
  });

  it("puts the placeholder in the token's place when there is no token to give", () => {
    const block = managedSettings({ url: URL_BASE, token: null, tier: "details" });

    for (const { hook } of handlers(block)) {
      expect(hook.headers.Authorization).toBe(`Bearer ${HOOK_TOKEN_PLACEHOLDER}`);
    }
  });
});
