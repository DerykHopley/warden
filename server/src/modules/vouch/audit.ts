// "Are we ready for the audit?" and the Audit-ready Level (spec #341, slice 4, stories 8 and 9), worked out on read
// from what Vouch stores: the Catalogues the Team has on, each judged Control's Verdict worked out now, and its newest
// review. Nothing is stored. The app reads them through `AuditReads` (ADR 0005: it imports no module).
import type { AuditAnswer, AuditControl, CatalogueId, ControlVerdict } from "@warden/contracts";
import type { AuditReads } from "../../app.ts";
import type { Catalogue } from "./catalogue.ts";
import type { ControlReviews } from "./control-reviews.ts";
import { judgeCatalogue, type VouchReads } from "./controls.ts";
import type { TeamAssets } from "./team-assets.ts";
import type { TeamCatalogues } from "./team-catalogues.ts";

/** What the answer reads of one judged Control: its text, its Verdict worked out now and its review state. */
export type ControlStanding = Pick<
  ControlVerdict,
  "ref" | "question" | "verdict" | "review_state" | "reviewed_verdict"
>;

/**
 * A Gap (GLOSSARY): reviewed, at not evidenced or partly evidenced. A Control not reviewed, or changed since review,
 * has no reviewed Verdict, so it waits instead.
 */
const isGap = ({ review_state, reviewed_verdict }: ControlStanding) =>
  review_state === "reviewed" &&
  (reviewed_verdict === "not_evidenced" || reviewed_verdict === "partly_evidenced");

/**
 * The answer from the Catalogues the Team has on, each with its judged Controls in the order it shows them: no
 * Catalogue on, no Catalogue; every Control reviewed with no Gap, yes; otherwise not yet.
 */
export function auditAnswerOf(
  on: readonly { catalogue: CatalogueId; controls: readonly ControlStanding[] }[],
): AuditAnswer {
  const controls: AuditControl[] = on.flatMap(({ catalogue, controls: standing }) =>
    standing.map((control) => ({
      catalogue,
      ref: control.ref,
      question: control.question,
      verdict: control.verdict,
      review_state: control.review_state,
      reviewed_verdict: control.reviewed_verdict,
      gap: isGap(control),
    })),
  );
  const gaps = controls.filter(({ gap }) => gap).length;
  const waiting = controls.filter(({ review_state }) => review_state !== "reviewed").length;
  if (on.length === 0) return { answer: "no_catalogue", gaps, waiting, controls };
  return { answer: gaps === 0 && waiting === 0 ? "yes" : "not_yet", gaps, waiting, controls };
}

/**
 * Audit-ready: at least one Catalogue is on, and every judged Control of each one on has a review, changed since
 * review included, with Gaps or without. `judged` and `reviewed` are Control refs.
 */
export function isAuditReady(
  catalogues: readonly { on: boolean; judged: readonly string[]; reviewed: readonly string[] }[],
): boolean {
  const on = catalogues.filter((catalogue) => catalogue.on);
  return (
    on.length > 0 &&
    on.every(({ judged, reviewed }) => judged.every((ref) => reviewed.includes(ref)))
  );
}

/**
 * The app's Vouch reads, from the same stores and Catalogues `vouchRoutes` takes: the answer, with rows that agree
 * with `GET /api/vouch/catalogues/:id/controls`, and whether the Team is Audit-ready, which reads only the switches
 * and the newest reviews, never the Findings. The reads run one after another.
 */
export function createAuditReads({
  teamCatalogues,
  catalogues,
  findings,
  teamAssets,
  controlReviews,
}: {
  teamCatalogues: TeamCatalogues;
  /** Every Catalogue Warden has, in the order the API lists them. */
  catalogues: readonly Catalogue[];
  findings: VouchReads;
  teamAssets: TeamAssets;
  controlReviews: ControlReviews;
}): AuditReads {
  /** The Catalogues `team` has on, in `catalogues`' order. */
  async function onFor(team: string): Promise<Catalogue[]> {
    const choices = await teamCatalogues.list(team);
    return catalogues.filter(
      (catalogue) => choices.find((choice) => choice.catalogue === catalogue.id)?.on ?? false,
    );
  }

  return {
    async answer(team, now) {
      const on = [];
      for (const catalogue of await onFor(team)) {
        on.push({
          catalogue: catalogue.id,
          controls: await judgeCatalogue(
            { findings, teamAssets, controlReviews },
            team,
            catalogue,
            now,
          ),
        });
      }
      return auditAnswerOf(on);
    },

    async auditReady(team) {
      const on = [];
      for (const catalogue of await onFor(team)) {
        const newest = await controlReviews.newest(team, catalogue.id);
        on.push({
          on: true,
          judged: catalogue.judgedControls.map(({ id }) => id),
          reviewed: newest.map(({ controlRef }) => controlRef),
        });
      }
      return isAuditReady(on);
    },
  };
}
