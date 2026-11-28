// The detail card's Session section (docs/design.md: Session section (Detail card)): an Agent session Finding's
// evidence, from the Finding alone, so it asks nothing. The hash of every event the Judge read, how many it read and
// relied on, then each event it relied on, in `seq` order: its place, time, name, tool and text. Every event's text is
// shown as text, never as markup, with its line breaks kept.
import type { SessionEvidence } from "@warden/contracts";
import { useId } from "react";
import { dayAndTimeWords } from "./date-words.ts";

/** "The Judge read 42 events and relied on these 2.", in the singular for one of either. */
export function readAndReliedWords(read: number, kept: number): string {
  const events = read === 1 ? "1 event" : `${read} events`;
  const relied = kept === 1 ? "this 1" : `these ${kept}`;
  return `The Judge read ${events} and relied on ${relied}.`;
}

export function SessionSection({ session }: { session: SessionEvidence }) {
  const headingId = useId();
  return (
    <section className="session-section" aria-labelledby={headingId}>
      <h4 id={headingId}>Session</h4>
      <dl className="detail-fields">
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
