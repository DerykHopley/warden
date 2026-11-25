// A Team's hook token (Guard spec, story 7), as the API answers it to the Team's Admin. The token is answered once,
// when issued; reading the settings answers only when it was issued. The Team comes from the session, never the
// request, and isn't answered.
import { z } from "zod";
import { DateTime } from "./finding.ts";

/**
 * `GET /api/hook`: the Team's current hook token's issue time (`token: null` before the first), and when the token
 * before it stops working (null when none still works). Never a token or its hash.
 */
export const HookSettingsBody = z.strictObject({
  token: z.strictObject({ issued_at: DateTime }).nullable(),
  previous_valid_until: DateTime.nullable(),
});
export type HookSettingsBody = z.infer<typeof HookSettingsBody>;

/**
 * `POST /api/hook/token` (201): the Team's new hook token, shown this once, when it was issued, and when the token it
 * replaced stops working, 24 h after (null for the Team's first).
 */
export const HookTokenBody = z.strictObject({
  token: z.string().min(1),
  issued_at: DateTime,
  previous_valid_until: DateTime.nullable(),
});
export type HookTokenBody = z.infer<typeof HookTokenBody>;
