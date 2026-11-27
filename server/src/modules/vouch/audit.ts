// "Are we ready for the audit?" and the Audit-ready Level (spec #341, slice 4, stories 8 and 9), worked out on read
// from what Vouch stores: the Catalogues the Team has on, each judged Control's Verdict worked out now, and its newest
// review. Nothing is stored. The app reads them through `AuditReads` (ADR 0005: it imports no module).
import type { AuditAnswer, AuditCatalogue, AuditControl, ControlVerdict } from "@warden/contracts";
import type { AuditReads } from "../../app.ts";
import { auditReadyOf } from "../../level.ts";
import type { Catalogue } from "./catalogue.ts";
import { judgeCatalogue } from "./controls.ts";
import type { VouchDeps } from "./deps.ts";
import { isOn } from "./team-catalogues.ts";

/** What the answer reads of one judged Control: its text, its Verdict worked out now and its review state. */
export type ControlStanding = Pick<
  ControlVerdict,
  "ref" | "question" | "verdict" | "review_state" | "reviewed_verdict"
>;

/** What the answer reads of a Catalogue on: what it is, and its credit and licence. */
export type AnsweredCatalogue = Pick<Catalogue, "id" | "name" | "date" | "credit" | "licence">;

/** `catalogue` as the API names it: what it is, and its credit and licence (`TeamCatalogue` and `AuditCatalogue`). */
export const catalogueAsAnswered = (catalogue: AnsweredCatalogue): AuditCatalogue => ({
  id: catalogue.id,
  name: catalogue.name,
  date: catalogue.date,
  credit: catalogue.credit,
  licence: catalogue.licence.name,
  licence_url: catalogue.licence.url,
});

/**
 * A Gap (GLOSSARY): reviewed, at not evidenced or partly evidenced. A Control not reviewed, or changed since review,
 * has no reviewed Verdict, so it waits instead.
 */
const isGap = ({ review_state, reviewed_verdict }: ControlStanding) =>
  review_state === "reviewed" &&
  (reviewed_verdict === "not_evidenced" || reviewed_verdict === "partly_evidenced");

/**
 * The answer from the Catalogues the Team has on, each with its judged Controls in the order it shows them: no
 * Catalogue on, no Catalogue; every Control reviewed with no Gap, yes; otherwise not yet. A Catalogue on that judges no
 * Control is never yes: there is nothing reviewed to be ready with. Each Catalogue on comes with the answer, in the
 * order given, with its credit and licence for wherever its Controls' text is shown.
 */
export function auditAnswerOf(
  on: readonly { catalogue: AnsweredCatalogue; controls: readonly ControlStanding[] }[],
): AuditAnswer {
  const catalogues = on.map(({ catalogue }) => catalogueAsAnswered(catalogue));
  const controls: AuditControl[] = on.flatMap(({ catalogue, controls: standing }) =>
    standing.map((control) => ({
      catalogue: catalogue.id,
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
  if (on.length === 0) return { answer: "no_catalogue", gaps, waiting, catalogues, controls };
  const judgesEach = on.every(({ controls: standing }) => standing.length > 0);
  return {
    answer: judgesEach && gaps === 0 && waiting === 0 ? "yes" : "not_yet",
    gaps,
    waiting,
    catalogues,
    controls,
  };
}

/**
 * Audit-ready, by the Level's rule (`auditReadyOf`): at least one Catalogue is on, each judging at least one Control,
 * and every judged Control of each one on has a review, changed since review included, with Gaps or without.
 * `judged` and `reviewed` are Control refs.
 */
export function isAuditReady(
  catalogues: readonly { on: boolean; judged: readonly string[]; reviewed: readonly string[] }[],
): boolean {
  return auditReadyOf(
    catalogues
      .filter((catalogue) => catalogue.on)
      .map(({ judged, reviewed }) =>
        judged.map((ref) => (reviewed.includes(ref) ? "reviewed" : "not_reviewed")),
      ),
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
}: VouchDeps): AuditReads {
  /** The Catalogues `team` has on, in `catalogues`' order. */
  async function onFor(team: string): Promise<Catalogue[]> {
    const choices = await teamCatalogues.list(team);
    return catalogues.filter((catalogue) => isOn(choices, catalogue.id));
  }

  return {
    async answer(team, now) {
      const on = [];
      for (const catalogue of await onFor(team)) {
        on.push({
          catalogue,
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
