// The managed-settings block (Guard spec, story 7): the JSON an Admin pastes into Claude Code's managed settings file
// to turn the hook on for every laptop of the Team. Names are Claude Code's own, from its hooks reference
// (https://code.claude.com/docs/en/hooks). It holds only Warden's hooks: no setting that would change hooks the Team
// didn't get from Warden (`allowManagedHooksOnly`, `httpHookAllowedEnvVars`).
import { HOOK_TOKEN_PLACEHOLDER, type PrivacyTier } from "@warden/contracts";

/** Where the hook sends its events, on Warden's own origin. Slice 10 serves it. */
export const HOOK_EVENTS_PATH = "/api/hook/events";

/** Seconds Claude Code waits for Warden before going on, so a slow Warden can't hold up a session. */
const TIMEOUT_SECONDS = 5;

/** The events every tier sends; `content` adds the developer's prompts (docs/data.md, "The Privacy tier"). */
const EVERY_TIER = ["SessionStart", "PostToolUse", "PostToolUseFailure", "SessionEnd"] as const;
const CONTENT_ONLY = ["UserPromptSubmit"] as const;

type HookEvent = (typeof EVERY_TIER)[number] | (typeof CONTENT_ONLY)[number];

/** Every event the block sends, at one tier or another: the only ones the hook endpoint stores. */
export const HOOK_EVENTS: readonly HookEvent[] = [...EVERY_TIER, ...CONTENT_ONLY];

/** Events whose matcher is the tool's name: `*` matches every tool. */
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "PostToolUseFailure"]);

/** Claude Code's `http` hook handler. */
type HttpHook = {
  type: "http";
  url: string;
  headers: { Authorization: string; "X-Warden-Developer": string };
  allowedEnvVars: string[];
  timeout: number;
};

/** One matcher group: with no matcher, it fires on every occurrence of its event. */
type HookGroup = { matcher?: string; hooks: HttpHook[] };

export type ManagedSettings = { hooks: Partial<Record<HookEvent, HookGroup[]>> };

/**
 * The block for a Team: `url` is Warden's own URL (its path is dropped for `HOOK_EVENTS_PATH`); `token` the Team's
 * hook token, or null for `HOOK_TOKEN_PLACEHOLDER`; `tier` the Team's Privacy tier. The token goes in a header,
 * never a URL (threat H5), and the developer in `X-Warden-Developer` from the laptop's `$USER`.
 */
export function managedSettings({
  url,
  token,
  tier,
}: {
  url: string;
  token: string | null;
  tier: PrivacyTier;
}): ManagedSettings {
  const hook: HttpHook = {
    type: "http",
    url: new URL(HOOK_EVENTS_PATH, url).href,
    headers: {
      Authorization: `Bearer ${token ?? HOOK_TOKEN_PLACEHOLDER}`,
      "X-Warden-Developer": "$USER",
    },
    allowedEnvVars: ["USER"],
    timeout: TIMEOUT_SECONDS,
  };
  const events: readonly HookEvent[] = tier === "content" ? HOOK_EVENTS : EVERY_TIER;
  return {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [TOOL_EVENTS.has(event) ? { matcher: "*", hooks: [hook] } : { hooks: [hook] }],
      ]),
    ),
  };
}
