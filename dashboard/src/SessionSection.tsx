// The detail card's Session section (docs/design.md: Session section (Detail card)): an Agent session Finding's
// session record, then its evidence. The record (the developer's pseudonym, and when the session started, ended and
// was judged) is asked when the card opens, once /api/me says the session is in the Finding's Team; the evidence is
// from the Finding alone, so it shows at once. The hash of every event the Judge read, how many it read and relied on,
// then each event it relied on, in `seq` order: its place, time, name, tool and text. Every event's text is shown as
// text, never as markup, with its line breaks kept.
import type { AgentSessionBody, Finding, SessionEvidence } from "@warden/contracts";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import {
  fetchSessionRecordInTeam,
  NO_SESSION_RECORD,
  NOT_ENDED,
  NOT_JUDGED,
  NOT_NAMED,
  SESSION_FAILED,
  SESSION_LOADING,
  shortPseudonym,
  type SessionRecordResult,
} from "./agent-session.ts";
import { sentence, tryAgainIn, type GetToken } from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { useWardenCall } from "./warden-call.tsx";

/** "The Judge read 42 events and relied on these 2.", in the singular for one of either. */
export function readAndReliedWords(read: number, kept: number): string {
  const events = read === 1 ? "1 event" : `${read} events`;
  const relied = kept === 1 ? "this 1" : `these ${kept}`;
  return `The Judge read ${events} and relied on ${relied}.`;
}

export function SessionSection(props: {
  finding: Finding;
  session: SessionEvidence;
  getToken: GetToken;
  onSessionEnded: () => void;
}) {
  const { finding, session, getToken } = props;
  const headingId = useId();
  // A new focus is a new Finding id: the record is asked again, and the earlier ask's answer dropped.
  const call = useCallback(
    () => fetchSessionRecordInTeam(getToken, finding.team, finding.id),
    [getToken, finding.team, finding.id],
  );
  const { result, refresh } = useWardenCall(call, props.onSessionEnded);
  // Retry keeps the refusal on screen while it asks again, its button busy until a new answer replaces it.
  const [retriedOn, setRetriedOn] = useState<SessionRecordResult | null>(null);
  // The ask a pressed Retry is waiting on: a new focus's ask is another, so its answer moves no focus.
  const retriedFor = useRef<typeof call | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const retry = () => {
    if (result === "loading") return;
    setRetriedOn(result);
    retriedFor.current = call;
    refresh();
  };

  // Once a pressed Retry is answered, focus that would sit on <body> (the button went, or was disabled while it ran)
  // goes to Retry when it shows again, else to the heading. Focus the person moved elsewhere stays there.
  // A layout effect, so focus moves in the commit that removes Retry, with no moment on <body> between.
  useLayoutEffect(() => {
    if (result === "loading" || result === retriedOn) return;
    const pressed = retriedFor.current === call;
    retriedFor.current = null;
    if (!pressed || result.kind === "session-ended") return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (retryRef.current ?? headingRef.current)?.focus();
  }, [result, retriedOn, call]);

  return (
    <section className="session-section" aria-labelledby={headingId}>
      <h4 id={headingId} ref={headingRef} tabIndex={-1}>
        Session
      </h4>
      {result === "loading" ? (
        <p className="session-record-line muted">{SESSION_LOADING}</p>
      ) : result.kind === "not-found" ? (
        <p className="session-record-line muted">
          {result.error === null ? NO_SESSION_RECORD : sentence(result.error)}
        </p>
      ) : result.kind === "record" || result.kind === "session-ended" ? null : (
        <p className="session-record-failed">
          <span className="muted">
            {result.kind === "too-many-attempts" ? tryAgainIn(result.retryAfter) : SESSION_FAILED}
          </span>
          {/* Named apart from the Proposals' and the Fix PR's Retry, which can show in the same card. */}
          <button
            ref={retryRef}
            type="button"
            className="secondary"
            onClick={retry}
            disabled={retriedOn === result}
            aria-busy={retriedOn === result}
            aria-label="Retry the session"
          >
            Retry
          </button>
        </p>
      )}
      <dl className="detail-fields">
        {result !== "loading" && result.kind === "record" && (
          <SessionRecordRows record={result.record} />
        )}
        <dt>Events hash</dt>
        <dd>
          <code className="session-hash">{session.events_hash}</code>
        </dd>
        <dt>Events</dt>
        <dd>
          <p className="session-read">
            {readAndReliedWords(session.events_read, session.events.length)}
          </p>
          {/* `SessionEvidence` keeps them in `seq` order: its parse refuses any other. */}
          <ul className="session-events">
            {session.events.map((event) => (
              <li key={event.seq} className="session-event">
                <p className="session-event-head">
                  <strong>Event {event.seq + 1}</strong>
                  <time dateTime={event.at}>{dayAndTimeWords(event.at)}</time>
                  <span>{event.name}</span>
                  {event.tool !== undefined && (
                    <code className="session-event-tool">{event.tool}</code>
                  )}
                </p>
                <pre className="session-event-text">{event.text}</pre>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </section>
  );
}

/** A record's time as a `<time>` in day and time words, or `none` when it has none. */
const timeOrNone = (at: string | null, none: string) =>
  at === null ? none : <time dateTime={at}>{dayAndTimeWords(at)}</time>;

function SessionRecordRows({ record }: { record: AgentSessionBody }) {
  return (
    <>
      <dt>Developer</dt>
      <dd>
        {record.developer === null ? (
          NOT_NAMED
        ) : (
          <>
            pseudonym <code className="session-pseudonym">{shortPseudonym(record.developer)}</code>
          </>
        )}
      </dd>
      <dt>Started</dt>
      <dd>
        <time dateTime={record.started_at}>{dayAndTimeWords(record.started_at)}</time>
      </dd>
      <dt>Ended</dt>
      <dd>{timeOrNone(record.ended_at, NOT_ENDED)}</dd>
      <dt>Judged</dt>
      <dd>{timeOrNone(record.judged_at, NOT_JUDGED)}</dd>
    </>
  );
}
