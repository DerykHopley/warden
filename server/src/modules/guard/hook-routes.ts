// Guard's hook token routes (story 7), mounted by the app through `moduleRoutes` (ADR 0005). Admin-only; the Team is
// always the session's, never the request's. Nothing here logs: the app's request line is the only line, and it
// holds no token or hash.
import type { HookSettingsBody, HookTokenBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import type { HookSettings } from "./hook-settings.ts";

const iso = (at: Date | null) => at?.toISOString() ?? null;

export function hookRoutes({ hookSettings }: { hookSettings: HookSettings }): MountRoutes {
  return (app, requireRole) => {
    // When the Team's token was issued, and when the one before it stops working: never a token.
    app.get("/api/hook", requireRole("admin"), async (c) => {
      const { issuedAt, previousValidUntil } = await hookSettings.read(c.get("team"));
      return c.json({
        token: issuedAt ? { issued_at: issuedAt.toISOString() } : null,
        previous_valid_until: iso(previousValidUntil),
      } satisfies HookSettingsBody);
    });

    // Issues the Team's first token or rotates it; the token is answered this once. It takes no body.
    app.post("/api/hook/token", requireRole("admin"), async (c) => {
      const issued = await hookSettings.issueToken(c.get("team"), {
        issuedBy: c.get("session").userId,
      });
      return c.json(
        {
          token: issued.token,
          issued_at: issued.issuedAt.toISOString(),
          previous_valid_until: iso(issued.previousValidUntil),
        } satisfies HookTokenBody,
        201,
      );
    });
  };
}
