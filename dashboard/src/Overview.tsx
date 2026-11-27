// The Overview page (story 10, and spec #341's stories 8 and 9; docs/design.md direction E): where the Team is on the
// journey (Quick, Standard, Audit-ready), the trend over 30 days, and "Are we ready for the audit?", answered from the
// Catalogues the Team has on, one row per judged Control, with each Catalogue's credit. A Lead and an Admin land here.
// Nothing on it moves, and its rows take no focus or click.
import type { AuditAnswer, AuditCatalogue, AuditControl, Role } from "@warden/contracts";
import type { PageProps } from "./App.tsx";
import {
  auditAnswerLine,
  JOURNEY_STATE_WORDS,
  journeyCards,
  NO_CATALOGUE_LINE,
  trendLine,
  useOverview,
  type JourneyCardView,
} from "./overview.ts";
import { CATALOGUES_ANCHOR, REVIEW_STATE_WORDS, VOUCH_VERDICT_WORDS } from "./vouch.ts";
import { CallRefused, TeamRefused } from "./warden-call.tsx";

export function OverviewPage({ getToken, me, onSessionEnded }: PageProps) {
  const call = useOverview(getToken, me.team, onSessionEnded);
  const body =
    call.result !== "loading" && call.result.kind === "overview" ? call.result.body : null;

  return (
    <>
      <h1>Overview</h1>
      {call.result === "loading" && <p className="muted">Loading Overview…</p>}
      {call.result !== "loading" && <CallRefused result={call.result} onRetry={call.retry} />}
      {call.result !== "loading" && <TeamRefused result={call.result} />}
      {body !== null && (
        <>
          <ol className="journey" aria-label="The journey">
            {journeyCards(body.level, body.last_scan_at, body.audit).map((card) => (
              <JourneyCard key={card.level} card={card} />
            ))}
          </ol>
          <p className="trend-line">{trendLine(body)}</p>
          <AuditSection audit={body.audit} role={me.role} />
        </>
      )}
    </>
  );
}

/** One Level on the journey: its word, what it adds, its bar, its state in words, and its next step. */
function JourneyCard({ card }: { card: JourneyCardView }) {
  return (
    <li
      className="journey-card"
      data-state={card.state}
      aria-current={card.state === "current" ? "step" : undefined}
    >
      <span className="journey-level">{card.word}</span>
      <span className="journey-adds">{card.adds}</span>
      <span
        className="journey-bar"
        role="progressbar"
        aria-label={card.word}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={card.progress}
      >
        <span className="journey-bar-fill" style={{ width: `${card.progress}%` }} />
      </span>
      <span className="journey-state">{JOURNEY_STATE_WORDS[card.state]}</span>
      {card.notes.map((note) => (
        <span key={note} className="journey-note">
          {note}
        </span>
      ))}
    </li>
  );
}

/**
 * "Are we ready for the audit?": the answer in one line, then each Catalogue on with its Controls and credit. With no
 * Catalogue on, the muted line and a pointer to Setup, a link only for an Admin, who can turn one on.
 */
function AuditSection({ audit, role }: { audit: AuditAnswer; role: Role | null }) {
  return (
    <section className="audit" aria-labelledby="audit">
      <h2 id="audit">Are we ready for the audit?</h2>
      {audit.answer === "no_catalogue" ? (
        <>
          <p className="muted">{NO_CATALOGUE_LINE}</p>
          <SetupPointer role={role} />
        </>
      ) : (
        <p className="audit-answer">{auditAnswerLine(audit)}</p>
      )}
      {audit.catalogues.map((catalogue) => (
        <AuditCatalogueBlock
          key={catalogue.id}
          catalogue={catalogue}
          controls={audit.controls.filter((control) => control.catalogue === catalogue.id)}
        />
      ))}
    </section>
  );
}

/** Where a Catalogue is turned on: Setup's Catalogues, linked for an Admin; nothing while the role isn't known. */
function SetupPointer({ role }: { role: Role | null }) {
  if (role === null) return null;
  if (role !== "admin") return <p className="muted">An Admin turns on a Catalogue on Setup.</p>;
  return (
    <p className="setup-line">
      Turn on a Catalogue on <a href={`/setup#${CATALOGUES_ANCHOR}`}>Setup</a>.
    </p>
  );
}

/** One Catalogue on: its name, its judged Controls in the server's order, and its credit and licence, last. */
function AuditCatalogueBlock({
  catalogue,
  controls,
}: {
  catalogue: AuditCatalogue;
  controls: AuditControl[];
}) {
  return (
    <>
      <h3>{catalogue.name}</h3>
      <ul className="audit-controls" aria-label={`${catalogue.name} Controls`}>
        {controls.map((control) => (
          <AuditControlRow key={control.ref} control={control} />
        ))}
      </ul>
      <p className="muted">{catalogue.credit}</p>
      <p className="muted catalogue-licence">
        Licence:{" "}
        <a href={catalogue.licence_url} target="_blank" rel="noreferrer">
          {catalogue.licence}
        </a>
      </p>
    </>
  );
}

/**
 * One judged Control, every state a word: its ref and question, its Verdict (the reviewed one while reviewed, the one
 * worked out now otherwise), its review state, and Gap when it is one.
 */
function AuditControlRow({ control }: { control: AuditControl }) {
  const verdict =
    control.review_state === "reviewed" && control.reviewed_verdict !== null
      ? control.reviewed_verdict
      : control.verdict;
  return (
    <li className="audit-control">
      <span className="audit-ref">{control.ref}</span>
      <span className="audit-question">{control.question}</span>
      <span className="audit-verdict">{VOUCH_VERDICT_WORDS[verdict]}</span>
      <span className="audit-review">{REVIEW_STATE_WORDS[control.review_state]}</span>
      {control.gap && <span className="audit-gap">Gap</span>}
    </li>
  );
}
