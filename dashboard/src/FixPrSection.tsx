// The detail card's Fix PR section (docs/design.md: Fix PR section (Detail card)): a Guard Finding's Fix PR, asked
// when the card opens on it. Its link, who opened it and when; and, for an Open Finding whose Rule and Location get a
// Fix PR, "Open a Fix PR" while the Team holds a write grant, or the line saying an Admin grants one. Most Guard cards
// aren't fixable, so nothing shows while it asks, nor when there's nothing to show. DetailCard keys it by the Finding's
// Status, so a decision asks again, and the earlier ask's answer is dropped.
import type { Finding, FixPrBody, Role } from "@warden/contracts";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NOT_ANSWERING, sentence, TEAM_NOT_OPENED, tryAgainIn, type GetToken } from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { FINDING_GONE } from "./decisions.ts";
import { openFixPrInTeam, readFixPrInTeam, type FixPrRead } from "./fix-pr.ts";
import { personName, type ClerkUser } from "./person-name.ts";
import { useWardenCall } from "./warden-call.tsx";

export const FIX_PR_FAILED = "Couldn't load the Fix PR.";
export const NO_WRITE_GRANT = "An Admin grants write access on Setup to open Fix PRs.";
/** No answer to the POST itself: it may have reached GitHub, and a second click gives back the PR it opened. */
export const MAYBE_OPENED =
  "Warden's server didn't answer, so a Fix PR may have been opened. Open a Fix PR again: it gives back the one already open.";
/** A refusal with no words from the server. */
const REFUSED = "Warden refused this.";

/** The section's one line: what was done (focused), or why the open was refused. */
type Line = { kind: "done" | "refused"; text: string };

export function FixPrSection(props: {
  finding: Finding;
  /** The person's Role: null (not loaded) shows no button. Any Role may open a Fix PR. */
  role: Role | null;
  /** The signed-in person's user id: their own Fix PR reads "Opened by you". */
  userId: string | null;
  clerkUsers: Map<string, ClerkUser>;
  getToken: GetToken;
  /** A 409: the Finding (or its grant) changed, or may have: the page asks for it again. */
  onFindingChanged: () => void;
  /** A 404: the Team has no such Finding. */
  onFindingGone: () => void;
  onSessionEnded: () => void;
}) {
  const { finding, getToken } = props;
  const { id, team, status } = finding;
  const headingId = useId();
  const call = useCallback(
    () => readFixPrInTeam(getToken, { id, team, status }),
    [getToken, id, team, status],
  );
  const { result, setResult, refresh } = useWardenCall(call, props.onSessionEnded);
  // Retry keeps the refusal on screen while it asks again, its button busy until a new answer replaces it.
  const [retriedOn, setRetriedOn] = useState<FixPrRead | null>(null);
  const [opening, setOpening] = useState(false);
  const openingNow = useRef(false);
  const [line, setLine] = useState<Line | null>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const focusLine = useRef(false);

  useEffect(() => {
    if (!focusLine.current) return;
    focusLine.current = false;
    lineRef.current?.focus();
  });

  const retry = () => {
    if (result === "loading") return;
    setRetriedOn(result);
    refresh();
  };

  /** One POST at a time: the button is busy while it runs, and a second press sends nothing. */
  async function open() {
    if (openingNow.current) return;
    openingNow.current = true;
    setOpening(true);
    setLine(null);
    const answer = await openFixPrInTeam(getToken, team, id);
    openingNow.current = false;
    setOpening(false);
    const refused = (text: string) => setLine({ kind: "refused", text });
    switch (answer.kind) {
      case "opened":
      case "still-open": {
        const { fixPr } = answer;
        setResult((old) => (old !== "loading" && old.kind === "read" ? { ...old, fixPr } : old));
        setLine({
          kind: "done",
          text:
            answer.kind === "opened"
              ? `Fix PR #${fixPr.number} opened.`
              : `Fix PR #${fixPr.number} is still open.`,
        });
        focusLine.current = true;
        return;
      }
      case "conflict":
        // An uninstalled write app (the server revoked its grant) hides the button; a Finding no longer Open drops it.
        refused(answer.error === null ? REFUSED : sentence(answer.error));
        refresh();
        props.onFindingChanged();
        return;
      case "refused":
        refused(answer.error === null ? REFUSED : sentence(answer.error));
        return;
      case "not-found":
        refused(FINDING_GONE);
        props.onFindingGone();
        return;
      case "too-many-attempts":
        refused(tryAgainIn(answer.retryAfter, "Fix PRs"));
        return;
      case "maybe-opened":
        refused(MAYBE_OPENED);
        refresh();
        return;
      case "not-answering":
        refused(NOT_ANSWERING);
        return;
      case "team-not-opened":
        refused(TEAM_NOT_OPENED);
        return;
      case "too-many-sign-ins":
        refused(tryAgainIn(answer.retryAfter));
        return;
      case "session-ended":
        props.onSessionEnded();
        return;
    }
  }

  let shown: ReactNode = null;
  if (result !== "loading" && result.kind === "read") {
    const offered = result.fixable && status === "open";
    const button = offered && result.granted === true && props.role !== null;
    const noGrant = offered && result.granted === false;
    if (result.fixPr !== null || button || noGrant) {
      shown = (
        <>
          {result.fixPr !== null && (
            <FixPrLink fixPr={result.fixPr} userId={props.userId} clerkUsers={props.clerkUsers} />
          )}
          {button && (
            <div className="fix-pr-actions">
              <button
                type="button"
                className="secondary"
                disabled={opening}
                aria-busy={opening ? "true" : undefined}
                onClick={() => void open()}
              >
                Open a Fix PR
              </button>
            </div>
          )}
          {noGrant && <p className="muted">{NO_WRITE_GRANT}</p>}
        </>
      );
    }
  } else if (
    result !== "loading" &&
    (result.kind === "not-answering" || result.kind === "too-many-attempts")
  ) {
    shown = (
      <p className="fix-pr-failed">
        <span className="muted">
          {result.kind === "too-many-attempts" ? tryAgainIn(result.retryAfter) : FIX_PR_FAILED}
        </span>
        {/* Named apart from the Proposals' Retry, which can show in the same card. */}
        <button
          type="button"
          className="secondary"
          onClick={retry}
          disabled={retriedOn === result}
          aria-busy={retriedOn === result}
          aria-label="Retry the Fix PR"
        >
          Retry
        </button>
      </p>
    );
  }
  // Waiting, a 404, an ended session, or nothing to show: no heading either.
  if (shown === null && line === null) return null;

  return (
    <section className="fix-pr-section" aria-labelledby={headingId}>
      <h4 id={headingId}>Fix PR</h4>
      {shown}
      {line !== null && (
        <p
          ref={lineRef}
          className={line.kind === "done" ? "card-line" : "card-line refused"}
          role={line.kind === "done" ? "status" : "alert"}
          tabIndex={-1}
        >
          {line.text}
        </p>
      )}
    </section>
  );
}

/** The Fix PR's link, in a new tab, and who opened it and when. Its URL is GitHub's (`FixPrBody` holds no other). */
function FixPrLink(props: {
  fixPr: FixPrBody;
  userId: string | null;
  clerkUsers: Map<string, ClerkUser>;
}) {
  const { fixPr } = props;
  const who =
    fixPr.opened_by === props.userId
      ? "you"
      : personName(fixPr.opened_by, props.clerkUsers.get(fixPr.opened_by));
  return (
    <>
      <p className="fix-pr-link">
        <a href={fixPr.url} target="_blank" rel="noopener noreferrer">
          Fix PR #{fixPr.number}
        </a>
      </p>
      <p className="fix-pr-opened muted">
        Opened by {who}, <time dateTime={fixPr.opened_at}>{dayAndTimeWords(fixPr.opened_at)}</time>
      </p>
    </>
  );
}
