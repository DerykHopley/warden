// The Overview page (story 10, and spec #341's stories 8 and 9; docs/design.md direction E): where the Team is on the
// journey (Quick, Standard, Audit-ready), the trend over 30 days, and "Are we ready for the audit?", answered from the
// Catalogues the Team has on, one row per judged Control, with each Catalogue's credit. A Lead and an Admin land here.
// Each row is a button that opens its Control in the Ask Warden panel's card (spec #341, slice 7a); the focused
// Control lives in the address, as the Findings page's focused Finding does.
import type { AuditAnswer, AuditCatalogue, AuditControl, Role } from "@warden/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageProps } from "./App.tsx";
import {
  auditAnswerLine,
  controlInAddress,
  controlGoneNotice,
  controlsByCatalogue,
  focusedControl,
  JOURNEY_STATE_WORDS,
  journeyCards,
  namesControl,
  NO_CATALOGUE_LINE,
  searchWithControl,
  shownVerdict,
  trendLine,
  useOverview,
  type ControlInAddress,
  type JourneyCardView,
} from "./overview.ts";
import { nothingToDo } from "./panel.ts";
import { CATALOGUES_ANCHOR, REVIEW_STATE_WORDS, VOUCH_VERDICT_WORDS } from "./vouch.ts";
import { CallRefused, TeamRefused } from "./warden-call.tsx";

/** Writes `control` into the address's entry in place: only its two params change, the rest of the entry stays. */
function showInAddress(control: ControlInAddress) {
  const search = searchWithControl(location.search, control);
  if (search !== location.search) {
    history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  }
}

export function OverviewPage({ getToken, me, onSessionEnded, panel }: PageProps) {
  const call = useOverview(getToken, me.team, onSessionEnded);
  const body =
    call.result !== "loading" && call.result.kind === "overview" ? call.result.body : null;
  const audit = body?.audit ?? null;

  // A Control the answer doesn't hold selects nothing; until the answer arrives it's kept as the address has it.
  const [selected, setSelected] = useState(() => controlInAddress(location.search));
  const focused = useMemo(
    () => (audit === null ? null : focusedControl(audit, selected)),
    [audit, selected],
  );
  const shown: ControlInAddress = useMemo(
    () =>
      audit === null
        ? selected
        : focused && { catalogue: focused.catalogue.id, ref: focused.control.ref },
    [audit, selected, focused],
  );

  // A review the card stored, of the Control it was sent from; and the notice when an answer asked for again no longer
  // holds the focused Control (#395). The card goes with its row, and the notice says what became of it, until a row
  // is selected. The focus that last answer showed is gone only while still selected: ✕ and another row change the
  // selection, so they say nothing, and a link the first answer doesn't hold was never shown.
  const [reviewed, setReviewed] = useState<
    (NonNullable<ControlInAddress> & { done: string }) | null
  >(null);
  const [goneNotice, setGoneNotice] = useState<string | null>(null);
  const [lastShownFocus, setLastShownFocus] = useState(focused);
  if (audit !== null && focused !== lastShownFocus) {
    setLastShownFocus(focused);
    if (
      lastShownFocus !== null &&
      focused === null &&
      namesControl(selected, lastShownFocus.control)
    ) {
      const done =
        reviewed !== null && namesControl(reviewed, lastShownFocus.control) ? reviewed.done : null;
      setGoneNotice(controlGoneNotice(lastShownFocus, audit, done));
    }
  }

  // The address always names the focus shown: one the answer doesn't hold is removed in place. As the page goes (a
  // Team switch, sign-out), its focus leaves the address, so the next Team's page doesn't open it as a link.
  useEffect(() => showInAddress(shown), [shown]);
  useEffect(
    () => () => {
      if (location.pathname === "/overview") showInAddress(null);
    },
    [],
  );

  // The Ask Warden panel talks about the focused Control, its card's ✕ clearing it; with none, about the page. A card
  // whose read is newer than its row asks the answer again, keeping the page on screen while it does.
  const { setContext, open: openPanel } = panel;
  const clearFocus = useCallback(() => {
    setSelected(null);
    setReviewed(null);
  }, []);
  const refreshRow = call.refresh;
  useEffect(() => {
    setContext(
      focused === null
        ? null
        : {
            view: ["Overview"],
            focus: null,
            control: {
              ...focused,
              clear: clearFocus,
              refreshRow,
              onReviewed: (done) =>
                setReviewed({ catalogue: focused.catalogue.id, ref: focused.control.ref, done }),
            },
            clearFocus,
            onFindingChanged: nothingToDo,
            onFindingGone: nothingToDo,
            candidates: [],
            productName: null,
          },
    );
  }, [setContext, focused, clearFocus, refreshRow]);
  // As the page goes (a Team switch, sign-out), its context goes with it.
  useEffect(() => () => setContext(null), [setContext]);

  // A link that names a Control opens a closed panel as selecting it does, once the answer holds it: only on the
  // page's load, so an answer asked for again doesn't reopen a panel the person closed.
  const linked = useRef(selected);
  useEffect(() => {
    if (linked.current === null || audit === null) return;
    if (focused !== null) openPanel();
    linked.current = null;
  }, [audit, focused, openPanel]);

  /**
   * Selecting a Control replaces the address's entry (the effect above writes it), and opens a closed panel. It removes
   * the notice, and a stored review of another Control, whose card has gone.
   */
  const select = useCallback(
    (control: AuditControl) => {
      setSelected({ catalogue: control.catalogue, ref: control.ref });
      setGoneNotice(null);
      setReviewed((was) => (namesControl(was, control) ? was : null));
      openPanel();
    },
    [openPanel],
  );

  return (
    <>
      <h1>Overview</h1>
      {goneNotice !== null && (
        <p className="notice" role="alert">
          {goneNotice}
        </p>
      )}
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
          <AuditSection audit={body.audit} role={me.role} selected={shown} onSelect={select} />
        </>
      )}
    </>
  );
}

/** What the audit section's rows need: which Control is focused, and selecting one. */
type Selection = { selected: ControlInAddress; onSelect: (control: AuditControl) => void };

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
function AuditSection({
  audit,
  role,
  ...selection
}: { audit: AuditAnswer; role: Role | null } & Selection) {
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
      {controlsByCatalogue(audit).map(({ catalogue, controls }) => (
        <AuditCatalogueBlock
          key={catalogue.id}
          catalogue={catalogue}
          controls={controls}
          {...selection}
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
  selected,
  onSelect,
}: {
  catalogue: AuditCatalogue;
  controls: AuditControl[];
} & Selection) {
  return (
    <>
      <h3>{catalogue.name}</h3>
      <ul className="audit-controls" aria-label={`${catalogue.name} Controls`}>
        {controls.map((control) => (
          <AuditControlRow
            key={control.ref}
            control={control}
            selected={namesControl(selected, control)}
            onSelect={onSelect}
          />
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
 * One judged Control, every state a word: its ref and question, the Verdict it shows (`shownVerdict`), its review
 * state, and Gap when it is one. The whole row is one button that opens its card; the focused one is current.
 */
function AuditControlRow({
  control,
  selected,
  onSelect,
}: {
  control: AuditControl;
  selected: boolean;
  onSelect: (control: AuditControl) => void;
}) {
  return (
    <li className="audit-control">
      <button
        type="button"
        className="audit-control-button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(control)}
      >
        <span className="audit-ref">{control.ref}</span>
        <span className="audit-question">{control.question}</span>
        <span className="audit-verdict">{VOUCH_VERDICT_WORDS[shownVerdict(control)]}</span>
        <span className="audit-review">{REVIEW_STATE_WORDS[control.review_state]}</span>
        {control.gap && <span className="audit-gap">Gap</span>}
      </button>
    </li>
  );
}
