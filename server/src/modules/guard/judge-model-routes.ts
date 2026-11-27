// The Team's own Judge model at the API (spec #225, slice 6a, story 10), mounted by the app through `moduleRoutes`
// (ADR 0005): an Admin reads it, sets it or clears it. Admin-only; the Team is always the session's, never the
// request's. A URL is stored only when the URL rule accepts it, with the server's localhost setting; a refusal says
// why, never echoing the URL. Nothing here logs: the app's request line is the only line.
import { JudgeModelChange, type JudgeModelBody } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { refusedBody } from "../../refused-body.ts";
import type { JudgeModels } from "./judge-models.ts";
import { checkJudgeUrl, type Resolve } from "./judge-url.ts";

export const JUDGE_MODEL_PATH = "/api/judge/model";

/**
 * `allowLocalhost` is the server's WARDEN_JUDGE_LOCALHOST. `resolve` looks a URL's host up; a test hands it a stub, so
 * no case reaches DNS.
 */
export function judgeModelRoutes({
  judgeModels,
  allowLocalhost,
  resolve,
}: {
  judgeModels: JudgeModels;
  allowLocalhost: boolean;
  resolve?: Resolve;
}): MountRoutes {
  async function body(team: string): Promise<JudgeModelBody> {
    const stored = await judgeModels.read(team);
    return {
      local_model: stored
        ? { url: stored.url, model: stored.model, set_at: stored.setAt.toISOString() }
        : null,
    };
  }

  return (app, requireRole) => {
    app.get(JUDGE_MODEL_PATH, requireRole("admin"), async (c) => c.json(await body(c.get("team"))));

    // Sets the Team's own model, replacing the last, or clears it with null. A refused body stores nothing.
    app.put(JUDGE_MODEL_PATH, requireRole("admin"), async (c) => {
      // A body that isn't JSON parses as undefined, which the schema refuses.
      const parsed = JudgeModelChange.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const team = c.get("team");
      const change = parsed.data.local_model;
      if (change === null) {
        await judgeModels.clear(team);
        return c.json(await body(team));
      }
      const checked = await checkJudgeUrl(change.url, { allowLocalhost, resolve });
      if (!checked.ok) return c.json({ error: `local_model.url: ${checked.reason}` }, 400);
      await judgeModels.set(team, {
        url: checked.url,
        model: change.model,
        setBy: c.get("session").userId,
      });
      return c.json(await body(team));
    });
  };
}
