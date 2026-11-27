// A Team's hook settings (Guard spec, story 7), as the API answers them to the Team's Admin: its hook token, its
// Privacy tier and the managed-settings block. The token is answered once, when issued; reading the settings answers
// only when it was issued. The Team comes from the session, never the request, and isn't answered.
import { z } from "zod";
import { DateTime } from "./finding.ts";

/**
 * How much of an Agent session's content the hook sends (GLOSSARY "Privacy tier"), lowest first. A Team that never
 * set one is at `details`.
 */
export const PrivacyTier = z.enum(["metadata", "details", "content"]);
export type PrivacyTier = z.infer<typeof PrivacyTier>;

/** `PUT /api/hook/privacy-tier`'s body: the Team's new Privacy tier. The answer is `HookSettingsBody`. */
export const PrivacyTierBody = z.strictObject({ privacy_tier: PrivacyTier });
export type PrivacyTierBody = z.infer<typeof PrivacyTierBody>;

/**
 * What stands in the token's place in the managed-settings block when there is no token to give: every read after the
 * answer that issued it. The dashboard swaps it for a token it holds, so the block it shows after a tier change still
 * works.
 */
export const HOOK_TOKEN_PLACEHOLDER = "<rotate the hook token in Warden to get a new one>";

/**
 * The managed-settings block an Admin pastes into Claude Code to turn the hook on. Its shape is Claude Code's (its
 * hooks reference), which the server's unit test checks, so here it is any JSON object.
 */
const ManagedSettings = z.record(z.string(), z.unknown());

/**
 * `GET /api/hook`: the Team's current hook token's issue time (`token: null` before the first), when the token
 * before it stops working (null when none still works), the Team's Privacy tier, and the managed-settings block at
 * that tier, with a placeholder in the token's place. Never a token or its hash.
 */
export const HookSettingsBody = z.strictObject({
  token: z.strictObject({ issued_at: DateTime }).nullable(),
  previous_valid_until: DateTime.nullable(),
  privacy_tier: PrivacyTier,
  managed_settings: ManagedSettings,
});
export type HookSettingsBody = z.infer<typeof HookSettingsBody>;

/**
 * `POST /api/hook/token` (201): the Team's new hook token, shown this once, when it was issued, when the token it
 * replaced stops working, 24 h after (null for the Team's first), and the managed-settings block with the new token
 * in it, at the Team's Privacy tier.
 */
export const HookTokenBody = z.strictObject({
  token: z.string().min(1),
  issued_at: DateTime,
  previous_valid_until: DateTime.nullable(),
  managed_settings: ManagedSettings,
});
export type HookTokenBody = z.infer<typeof HookTokenBody>;

/**
 * `GET /api/judge/model` and `PUT`'s answer (spec #225, slice 6a, story 10): the Team's own Judge model, its
 * OpenAI-compatible base URL and model name and when it was set, or null when the Team is judged on OpenRouter.
 */
export const JudgeModelBody = z.strictObject({
  local_model: z.strictObject({ url: z.string(), model: z.string(), set_at: DateTime }).nullable(),
});
export type JudgeModelBody = z.infer<typeof JudgeModelBody>;

/**
 * `PUT /api/judge/model`'s body: the Team's own model, or null to clear it. The model name is 1 to 200 characters, not
 * only spaces, with no control character, each refusal in plain words, as Setup shows them (#464); the server checks
 * the URL against its URL rule.
 */
export const JudgeModelChange = z.strictObject({
  local_model: z
    .strictObject({
      url: z.string(),
      model: z
        .string()
        // An empty name is only that: not "only spaces" as well.
        .min(1, { message: "is empty", abort: true })
        .max(200, { message: "is over 200 characters" })
        .regex(/\S/, { message: "is only spaces" })
        .regex(/^\P{Cc}*$/u, { message: "holds a control character" }),
    })
    .nullable(),
});
export type JudgeModelChange = z.infer<typeof JudgeModelChange>;
