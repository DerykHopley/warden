// Guard's hook routes (story 7), mounted by the app through `moduleRoutes` (ADR 0005): the Team's hook token, its
// Privacy tier, and the managed-settings block. Admin-only; the Team is always the session's, never the request's.
// Nothing here logs: the app's request line is the only line, and it holds no token or hash.
import { PrivacyTierBody, type HookSettingsBody, type HookTokenBody } from "@warden/contracts";
import type { Context } from "hono";
import type { MountRoutes } from "../../app.ts";
import { refusedBody } from "../../refused-body.ts";
import type { HookSettings } from "./hook-settings.ts";
import { managedSettings } from "./managed-settings.ts";

/**
 * Warden's own origin, as the request reached it: its host, and `https` when the front end says TLS ended there
 * (Cloud Run sets `X-Forwarded-Proto`), else the request URL's own scheme. A forged header changes only the calling
 * Admin's own answer.
 */
function ownOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const scheme = c.req.header("X-Forwarded-Proto") === "https" ? "https:" : url.protocol;
  return `${scheme}//${url.host}`;
}

export function hookRoutes({ hookSettings }: { hookSettings: HookSettings }): MountRoutes {
  /** The Team's settings as `GET /api/hook` answers them: never a token, so the block holds the placeholder. */
  async function settingsBody(c: Context, team: string): Promise<HookSettingsBody> {
    const { issuedAt, previousValidUntil, privacyTier } = await hookSettings.read(team);
    return {
      token: issuedAt ? { issued_at: issuedAt.toISOString() } : null,
      previous_valid_until: previousValidUntil?.toISOString() ?? null,
      privacy_tier: privacyTier,
      managed_settings: managedSettings({ url: ownOrigin(c), token: null, tier: privacyTier }),
    };
  }

  return (app, requireRole) => {
    // When the Team's token was issued, when the one before it stops working, the Privacy tier and the block.
    app.get("/api/hook", requireRole("admin"), async (c) =>
      c.json(await settingsBody(c, c.get("team"))),
    );

    // Issues the Team's first token or rotates it; the token is answered this once, also in the block. No body.
    app.post("/api/hook/token", requireRole("admin"), async (c) => {
      const team = c.get("team");
      const issued = await hookSettings.issueToken(team, { issuedBy: c.get("session").userId });
      const { privacyTier } = await hookSettings.read(team);
      return c.json(
        {
          token: issued.token,
          issued_at: issued.issuedAt.toISOString(),
          previous_valid_until: issued.previousValidUntil?.toISOString() ?? null,
          managed_settings: managedSettings({
            url: ownOrigin(c),
            token: issued.token,
            tier: privacyTier,
          }),
        } satisfies HookTokenBody,
        201,
      );
    });

    // Sets the Team's Privacy tier, replacing the last. A refused body stores nothing.
    app.put("/api/hook/privacy-tier", requireRole("admin"), async (c) => {
      // A body that isn't JSON parses as undefined, which the schema refuses.
      const parsed = PrivacyTierBody.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const team = c.get("team");
      await hookSettings.setPrivacyTier(team, {
        tier: parsed.data.privacy_tier,
        setBy: c.get("session").userId,
      });
      return c.json(await settingsBody(c, team));
    });
  };
}
