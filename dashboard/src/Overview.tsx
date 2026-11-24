// The Overview page (story 10, docs/design.md direction E): where the Team is on the journey (Quick, Standard,
// Audit-ready), the trend over 30 days, and "Are we ready for the audit?", which Vouch answers later. A Lead and an
// Admin land here. Nothing on it moves.
import type { PageProps } from "./App.tsx";
import {
  JOURNEY_STATE_WORDS,
  journeyCards,
  trendLine,
  useOverview,
  type JourneyCardView,
} from "./overview.ts";
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
            {journeyCards(body.level, body.last_scan_at).map((card) => (
              <JourneyCard key={card.level} card={card} />
            ))}
          </ol>
          <p className="trend-line">{trendLine(body)}</p>
          <section className="audit" aria-labelledby="audit">
            <h2 id="audit">Are we ready for the audit?</h2>
            <p className="muted">
              Warden can answer this at Audit-ready, once Vouch checks your Controls.
            </p>
          </section>
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
