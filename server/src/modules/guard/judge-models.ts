// A Team's own Judge model (spec #225, slice 6a, story 10): its OpenAI-compatible base URL and model name, one row per
// Team in `judge_models` (0020), replaced on each change and deleted when cleared. Every call runs inside `withTeam`,
// never across Teams (ADR 0006). The URL is checked against the URL rule before it reaches here.
import { sql, type Generated } from "kysely";
import type { WithTeam } from "../../with-team.ts";

/** Guard's Judge models table, added to `withTeam`'s transaction with `$extendTables`, so `schema.ts` stays as it is. */
export type JudgeModelTables = {
  judge_models: {
    team_id: string;
    url: string;
    model: string;
    set_by: string;
    set_at: Generated<Date>;
  };
};

/** A Team's own model: its URL and model name, who set it and when. */
export type TeamJudgeModel = { url: string; model: string; setBy: string; setAt: Date };

export interface JudgeModels {
  /** The Team's own model, or undefined when it has none (it's judged on OpenRouter). */
  read(team: string): Promise<TeamJudgeModel | undefined>;
  /** Stores the Team's own model, with who set it, replacing the last. */
  set(team: string, change: { url: string; model: string; setBy: string }): Promise<void>;
  /** Deletes the Team's own model: its next run is on OpenRouter. */
  clear(team: string): Promise<void>;
}

export function createJudgeModels({ withTeam }: { withTeam: WithTeam }): JudgeModels {
  return {
    async read(team) {
      const row = await withTeam(team, (tx) =>
        tx
          .$extendTables<JudgeModelTables>()
          .selectFrom("judge_models")
          .select(["url", "model", "set_by", "set_at"])
          .executeTakeFirst(),
      );
      return row && { url: row.url, model: row.model, setBy: row.set_by, setAt: row.set_at };
    },

    async set(team, { url, model, setBy }) {
      await withTeam(team, (tx) =>
        tx
          .$extendTables<JudgeModelTables>()
          .insertInto("judge_models")
          .values({ team_id: team, url, model, set_by: setBy })
          .onConflict((conflict) =>
            conflict
              .column("team_id")
              .doUpdateSet({ url, model, set_by: setBy, set_at: sql<Date>`now()` }),
          )
          .execute(),
      );
    },

    async clear(team) {
      await withTeam(team, (tx) =>
        tx.$extendTables<JudgeModelTables>().deleteFrom("judge_models").execute(),
      );
    },
  };
}
