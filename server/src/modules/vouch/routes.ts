// Vouch's routes (spec #341, slice 1b), mounted by the app through `moduleRoutes` (ADR 0005): every Catalogue Warden
// has, as the Team sees it, and an Admin's switch to turn one on or off. The Team is always the session's, never the
// request's. The Catalogues are loaded once, at start-up, by whoever wires these routes.
import { CatalogueSwitchBody, type CataloguesBody, type TeamCatalogue } from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { pathId } from "../../path-id.ts";
import { refusedBody } from "../../refused-body.ts";
import type { Catalogue } from "./catalogue.ts";
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

export function vouchRoutes({
  teamCatalogues,
  catalogues,
}: {
  teamCatalogues: TeamCatalogues;
  /** Every Catalogue Warden has, in the order the API lists them. */
  catalogues: readonly Catalogue[];
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

  return (app, requireRole) => {
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
      const id = pathId(c.req.param("id"));
      const catalogue = catalogues.find((candidate) => candidate.id === id);
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
