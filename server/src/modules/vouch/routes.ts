// Vouch's routes (spec #341, slices 1b, 2b and 3), mounted by the app through `moduleRoutes` (ADR 0005): every
// Catalogue Warden has, as the Team sees it, an Admin's switch to turn one on or off, each judged Control's Verdict,
// reason, evidence and review state, and a Lead's review of a Verdict. The Team and the person who reviewed are always
// the session's, never the request's. The Catalogues are loaded once, at start-up, by whoever wires these routes, and so
// are the Team's Assets (`TeamAssets`), as Vouch imports neither Guard nor Patch.
import {
  CatalogueSwitchBody,
  ReviewBody,
  type CataloguesBody,
  type ControlDetail,
  type ControlReview,
  type ControlsBody,
  type TeamCatalogue,
} from "@warden/contracts";
import type { MountRoutes } from "../../app.ts";
import { pathId } from "../../path-id.ts";
import { refusedBody } from "../../refused-body.ts";
import type { Catalogue, Control } from "./catalogue.ts";
import type { StoredControlReview } from "./control-reviews.ts";
import { judgeCatalogue, judgeControls, type JudgedControl } from "./controls.ts";
import type { VouchDeps } from "./deps.ts";
import { withReviewState } from "./review-state.ts";
import { isOn, type TeamCatalogueChoice } from "./team-catalogues.ts";

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

/** The judged Control `ref` names in `catalogue`, or undefined for a ref of the wrong shape or one it doesn't judge. */
const controlOf = (catalogue: Catalogue, ref: string) =>
  CONTROL_REF.test(ref) ? catalogue.judgedControls.find(({ id }) => id === ref) : undefined;

/** A stored review as the API answers it. */
const controlReviewOf = (review: StoredControlReview): ControlReview => ({
  id: review.id,
  worked_out_verdict: review.workedOutVerdict,
  outcome: review.outcome,
  verdict: review.verdict,
  reason: review.reason,
  reviewed_by: review.reviewedBy,
  reviewed_at: review.reviewedAt.toISOString(),
});

export function vouchRoutes({
  teamCatalogues,
  catalogues,
  findings,
  teamAssets,
  controlReviews,
}: VouchDeps): MountRoutes {
  /** One Control as `GET .../controls/:ref` answers it: `judged`, its review state and its reviews. */
  async function detailOf(
    team: string,
    catalogue: Catalogue,
    judged: JudgedControl,
  ): Promise<ControlDetail> {
    const reviews = (await controlReviews.history(team, catalogue.id, judged.ref)).map(
      controlReviewOf,
    );
    return { ...withReviewState(judged, reviews), reviews };
  }

  /** `control`, judged for `team` now. */
  async function judgeOne(team: string, control: Control): Promise<JudgedControl> {
    const [judged] = await judgeControls({ findings, teamAssets }, team, [control], new Date());
    if (judged === undefined) throw new Error(`judgeControls answered nothing for ${control.id}`);
    return judged;
  }

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

  return (app, requireRole) => {
    // Any person in the Team reads each judged Control's Verdict, reason and evidence, worked out now from the last 30
    // days, whether the Catalogue is on or off, with its review state from its newest review. Nothing is stored.
    app.get("/api/vouch/catalogues/:id/controls", requireRole("member"), async (c) => {
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const team = c.get("team");
      const on = isOn(await teamCatalogues.list(team), catalogue.id);
      const controls = await judgeCatalogue(
        { findings, teamAssets, controlReviews },
        team,
        catalogue,
        new Date(),
      );
      return c.json({ catalogue: catalogue.id, on, controls } satisfies ControlsBody);
    });

    // One judged Control, as the list shows it, with its reviews newest first. A ref of the wrong shape, or one the
    // Catalogue doesn't judge, answers 404 before any store is read.
    app.get("/api/vouch/catalogues/:id/controls/:ref", requireRole("member"), async (c) => {
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const control = controlOf(catalogue, c.req.param("ref"));
      if (control === undefined) return c.json({ error: "No such Control" }, 404);
      const team = c.get("team");
      return c.json(await detailOf(team, catalogue, await judgeOne(team, control)));
    });

    // A Lead (or an Admin) confirms the Verdict worked out now, or overrides it to another; a Member gets requireRole's
    // 403. The Verdict is worked out here, never taken from the body, and stored with the review, so a later read sees
    // whether it changed since. The person who reviewed is the session's. Taken whether the Catalogue is on or off, as the
    // reads are. A refused body (400), a Catalogue Warden doesn't have or a Control it doesn't judge (404, before any
    // store is touched), or an override that changes nothing (400) stores nothing.
    app.post("/api/vouch/catalogues/:id/controls/:ref/reviews", requireRole("lead"), async (c) => {
      // A body that isn't JSON parses as undefined, which the schema refuses.
      const parsed = ReviewBody.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
      const catalogue = catalogueOf(c.req.param("id"));
      if (catalogue === undefined) return c.json({ error: "No such Catalogue" }, 404);
      const control = controlOf(catalogue, c.req.param("ref"));
      if (control === undefined) return c.json({ error: "No such Control" }, 404);
      const team = c.get("team");
      const judged = await judgeOne(team, control);
      const body = parsed.data;
      if (body.outcome === "override" && body.verdict === judged.verdict) {
        return c.json({ error: "An override must change the Verdict; confirm it instead" }, 400);
      }
      await controlReviews.add(team, {
        catalogue: catalogue.id,
        controlRef: control.id,
        workedOutVerdict: judged.verdict,
        ...(body.outcome === "confirm"
          ? { outcome: "confirmed", verdict: judged.verdict }
          : { outcome: "overridden", verdict: body.verdict }),
        reason: body.reason ?? null,
        reviewedBy: c.get("session").userId,
      });
      // The answer is the Control as `GET .../controls/:ref` now shows it, its reviews read back from what was stored.
      return c.json(await detailOf(team, catalogue, judged), 201);
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
