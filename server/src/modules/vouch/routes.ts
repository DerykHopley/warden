// Vouch's routes (spec #341, slices 1b and 2b), mounted by the app through `moduleRoutes` (ADR 0005): every Catalogue
// Warden has, as the Team sees it, an Admin's switch to turn one on or off, and each judged Control's Verdict, reason
// and evidence. The Team is always the session's, never the request's. The Catalogues are loaded once, at start-up, by
// whoever wires these routes, and so are the Team's Assets (`TeamAssets`), as Vouch imports neither Guard nor Patch.
import {
  CatalogueSwitchBody,
  type CataloguesBody,
  type ControlsBody,
  type ControlVerdict,
  type TeamCatalogue,
} from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { pathId } from "../../path-id.ts";
import { refusedBody } from "../../refused-body.ts";
import type { Catalogue } from "./catalogue.ts";
import { judgeControls, type VouchReads } from "./controls.ts";
import type { TeamAssets } from "./team-assets.ts";
import type { TeamCatalogueChoice, TeamCatalogues } from "./team-catalogues.ts";

/** `catalogue` as the Team sees it, with the Team's `choice` (none: off, set by no one). */
function teamCatalogue(
  catalogue: Catalogue,
  choice: TeamCatalogueChoice | undefined,
): TeamCatalogue {
  return {
    id: catalogue.id,
    name: catalogue.name,
    date: catalogue.date,
    credit: catalogue.credit,
    licence: catalogue.licence.name,
    licence_url: catalogue.licence.url,
    on: choice?.on ?? false,
    set_by: choice?.setBy ?? null,
    set_at: choice?.setAt.toISOString() ?? null,
    controls: catalogue.judgedControls.map(({ id, question, iso_27001 }) => ({
      ref: id,
      question,
      iso_27001,
    })),
  };
}

/** A Control's ref as the Catalogue numbers it: dotted numbers, such as 1.3.3. */
const CONTROL_REF = /^\d+(\.\d+)*$/;

export function vouchRoutes({
  teamCatalogues,
  catalogues,
  findings,
  teamAssets,
}: {
  teamCatalogues: TeamCatalogues;
  /** Every Catalogue Warden has, in the order the API lists them. */
  catalogues: readonly Catalogue[];
  findings: VouchReads;
  teamAssets: TeamAssets;
}): MountRoutes {
  /** Each of `wanted` as `team` sees it. */
  async function asSeenBy(team: string, wanted: readonly Catalogue[]): Promise<TeamCatalogue[]> {
    const choices = await teamCatalogues.list(team);
    return wanted.map((catalogue) =>
      teamCatalogue(
        catalogue,
        choices.find((choice) => choice.catalogue === catalogue.id),
      ),
    );
  }

  /** The Catalogue the path's `:id` names, or undefined for one Warden doesn't have (or an id that can be none). */
  const catalogueOf = (id: string | undefined) => {
    const wanted = pathId(id);
    return catalogues.find((candidate) => candidate.id === wanted);
  };

  /** Whether `team` has `catalogue` on (none set: off). */
  const isOn = async (team: string, catalogue: Catalogue) =>
    (await teamCatalogues.list(team)).find((choice) => choice.catalogue === catalogue.id)?.on ??
    false;

  return (app, requireRole) => {
    // Any person in the Team reads each judged Control's Verdict, reason and evidence, worked out now from the last 30
    // days, whether the Catalogue is on or off. Nothing is stored.
    app.get("/api/vouch/catalogues/:id/controls", requireRole("member"), async (c) => {
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const team = c.get("team");
      const on = await isOn(team, catalogue);
      const controls = await judgeControls(
        { findings, teamAssets },
        team,
        catalogue.judgedControls,
        new Date(),
      );
      return c.json({ catalogue: catalogue.id, on, controls } satisfies ControlsBody);
    });

    // One judged Control, as the list shows it. A ref of the wrong shape, or one the Catalogue doesn't judge, answers
    // 404 before any store is read.
    app.get("/api/vouch/catalogues/:id/controls/:ref", requireRole("member"), async (c) => {
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const ref = c.req.param("ref");
      const control = CONTROL_REF.test(ref)
        ? catalogue.judgedControls.find(({ id }) => id === ref)
        : undefined;
      if (control === undefined) return c.json({ error: "No such Control" }, 404);
      const answers: ControlVerdict[] = await judgeControls(
        { findings, teamAssets },
        c.get("team"),
        [control],
        new Date(),
      );
      return c.json(answers[0]);
    });

    // Any person in the Team reads every Catalogue, whether it is on, and its judged Controls.
    app.get("/api/vouch/catalogues", requireRole("member"), async (c) =>
      c.json({ catalogues: await asSeenBy(c.get("team"), catalogues) } satisfies CataloguesBody),
    );

    // An Admin turns one on or off, replacing the last choice; a Lead or a Member gets requireRole's 403. A refused
    // body (400) or a Catalogue Warden doesn't have (404) stores nothing.
    app.put("/api/vouch/catalogues/:id", requireRole("admin"), async (c) => {
      // A body that isn't JSON parses as undefined, which the schema refuses.
      const parsed = CatalogueSwitchBody.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const team = c.get("team");
      await teamCatalogues.set(team, {
        catalogue: catalogue.id,
        on: parsed.data.on,
        setBy: c.get("session").userId,
      });
      // The answer is the Catalogue as `GET` now shows it, read back from what was stored.
      const [answer] = await asSeenBy(team, [catalogue]);
      return c.json(answer);
    });
  };
}
