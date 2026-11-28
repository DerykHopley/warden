// The session record's route (spec #225, slice 9b, stories 9 and 15), mounted by the app through `moduleRoutes` (ADR
// 0005): an Agent session Finding's pseudonym and its started, ended and judged times, for the detail card's Session
// section. Read from `agent_sessions` alone, never `agent_events`, so it answers the same after the Judge drops the
// events. The Team is always the session's, never the request's.
import { AgentSessionBody, type Finding } from "@warden/contracts";
import type { Context } from "hono";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { FindingNotFound, type Findings } from "../../findings/index.ts";
import { idParam } from "../../path-id.ts";
import type { AgentSessions, SessionRecord } from "./agent-sessions.ts";

const NOT_A_SESSION = "This Finding isn't on an Agent session";
const NO_RECORD = "Warden holds no record of this session";

function sessionBody(record: SessionRecord): AgentSessionBody {
  return {
    developer: record.developer,
    started_at: record.startedAt.toISOString(),
    ended_at: record.endedAt?.toISOString() ?? null,
    judged_at: record.judgedAt?.toISOString() ?? null,
  };
}

export function agentSessionRoutes({
  findings,
  agentSessions,
}: {
  findings: Pick<Findings, "list">;
  agentSessions: Pick<AgentSessions, "record">;
}): MountRoutes {
  /** The Team's Finding the path names, or FindingNotFound. The Findings module has no one-Finding read. */
  async function findingOf(c: Context<AppEnv>): Promise<Finding> {
    const id = idParam(c, FindingNotFound);
    const finding = (await findings.list(c.get("team"))).find((f) => f.id === id);
    if (finding === undefined) throw new FindingNotFound(id);
    return finding;
  }

  return (app, requireRole) => {
    // Any person in the Team reads an Agent session Finding's session record. An id that isn't one of the Team's
    // Findings is a 404 naming nothing of anyone's; a Finding on another Asset, or a session with no record (the
    // demo's made-up one), is a 404 in its own words. The answer is parsed, not only typed.
    app.get("/api/guard/findings/:id/session", requireRole("member"), async (c) => {
      let finding: Finding;
      try {
        finding = await findingOf(c);
      } catch (error) {
        if (error instanceof FindingNotFound) return c.json({ error: "No such Finding" }, 404);
        throw error;
      }
      if (finding.asset.kind !== "agent_session") return c.json({ error: NOT_A_SESSION }, 404);
      const record = await agentSessions.record(c.get("team"), finding.asset.ref);
      if (record === undefined) return c.json({ error: NO_RECORD }, 404);
      return c.json(AgentSessionBody.parse(sessionBody(record)));
    });
  };
}
