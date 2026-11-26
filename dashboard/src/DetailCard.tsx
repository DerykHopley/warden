// The detail card (docs/design.md: Side panel, Detail card): the Finding the page has focused, above the chat, in its
// own tint, with its own ✕. Its fields; then a Lead's decisions on it, or a Member's Proposals (story 4); then its
// pending Proposals, each its own list item, with a Lead's Approve and Reject. One form at a time, in place of the
// button that opened it. The server checks the Role on every call (ADR 0008): the card only hides what a Role can't do.
import {
  atLeast,
  type Decision,
  type Finding,
  type PendingProposal,
  type ProposalDecision,
  type Role,
} from "@warden/contracts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { sentence, tryAgainIn, type GetToken } from "./api.ts";
import { dayAndTimeWords, dayWords } from "./date-words.ts";
import {
  approveProposal,
  decide,
  decisionsFor,
  earliestUntil,
  FINDING_GONE,
  mergeableCandidates,
  proposalsFor,
  propose,
  rejectProposal,
  startOfDay,
  type ActionResult,
  type DecisionRequest,
} from "./decisions.ts";
import {
  ASSET_KIND_WORDS,
  locationWords,
  MODULE_WORDS,
  PROPOSAL_DECISION_WORDS,
  STATUS_WORDS,
  UNCONFIRMED_FIX,
} from "./finding-words.ts";
import { shortId } from "./findings.ts";
import { FixPrSection } from "./FixPrSection.tsx";
import { PatchSection } from "./PatchSection.tsx";
import { personName, type ClerkUser } from "./person-name.ts";
import type { ProposalsResult } from "./proposals.ts";
import { SeverityPill } from "./SeverityPill.tsx";

/** What a person can do from the card. Each but approve opens a form. */
type Action =
  | { kind: "decide"; decision: Decision }
  | { kind: "propose"; decision: ProposalDecision }
  | { kind: "reject"; proposal: string }
  | { kind: "approve"; proposal: string };

/** An action's key: the opener button's `data-opener`, and where a refusal line belongs. */
const keyOf = (action: Action) =>
  action.kind === "reject" || action.kind === "approve"
    ? `${action.kind}:${action.proposal}`
    : `${action.kind}:${action.decision}`;

const DECISION_LABELS: Record<Decision, string> = {
  accept: "Accept",
  mark_false_positive: "Mark False positive",
  confirm_fix: "Confirm fix",
  mark_moved: "Mark moved",
  reopen: "Reopen",
};

/** Accepting an Accepted Finding again renews its acceptance. */
const renews = (decision: Decision, finding: Finding) =>
  decision === "accept" && finding.status === "accepted";

/** A decision's button and submit: "Renew acceptance" when the decision renews. */
const decisionLabel = (decision: Decision, finding: Finding) =>
  renews(decision, finding) ? "Renew acceptance" : DECISION_LABELS[decision];

/** A Member's buttons: "Propose", the glossary's word (never "Suggest"). */
const PROPOSE_LABELS: Record<ProposalDecision, string> = {
  accept: "Propose accepting",
  mark_false_positive: "Propose False positive",
};

/** What the done line says after a decision. */
function doneWords(call: DecisionRequest): string {
  switch (call.decision) {
    case "accept":
      return `Accepted. Reopens on ${dayWords(call.body.until)}.`;
    case "mark_false_positive":
      return "Marked a False positive.";
    case "confirm_fix":
      return "Fix confirmed.";
    case "mark_moved":
      return `Marked moved: ${shortId(call.body.candidate)} merged into this Finding.`;
    case "reopen":
      return "Reopened.";
  }
}

const REFUSED = {
  leadOnly: "Only a Lead or an Admin can decide this. Your Role may have changed.",
  proposeForbidden: "Warden refused this: your Team or Role may have changed.",
  findingGone: FINDING_GONE,
  findingChanged: "This Finding changed since you opened it. Look again before deciding.",
  proposalGone: "This Proposal is no longer in your Team.",
  proposalChanged:
    "This Proposal was decided already, or its Finding changed. The list is refreshed.",
  notAnswering: "Warden's server isn't answering. Your reason is kept: try again.",
  untilPassed: "Reopens on must be a later day. Pick tomorrow or later.",
};

/** What a form holds while it's open: kept as typed after a refusal. */
type Draft = { reason: string; until: string; candidate: string | null };
const EMPTY_DRAFT: Draft = { reason: "", until: "", candidate: null };

/** The card's one line: what was done (focused), or why a call was refused, at the action it answers. */
type Line = { kind: "done"; text: string } | { kind: "refused"; text: string; at: string };

export function DetailCard(props: {
  finding: Finding;
  /** The Team's pending Proposals, or loading. Only the focused Finding's show. */
  proposals: ProposalsResult | "loading";
  clerkUsers: Map<string, ClerkUser>;
  /** The person's Role in the Team: a Lead or Admin decides, a Member proposes; null (not loaded) does neither. */
  role: Role | null;
  /** The signed-in person's user id: their own Proposals read "Asked by you". */
  userId: string | null;
  getToken: GetToken;
  /** The focused Finding's Unconfirmed-fix candidates the page's list holds: Mark moved's choices. */
  candidates: Finding[];
  /** The Asset's words from the page (a Product's name); null shows the Asset's ref. */
  assetName: string | null;
  /** The card's ✕: clears the page's focus. */
  onClear: () => void;
  /** Asks for the Proposals again, after they couldn't load. */
  onRetryProposals: () => void;
  /** A decision or an approval changed the Finding (or may have): the page asks for it again. */
  onFindingChanged: () => void;
  /** The server has no such Finding in the Team (404): the page says so, past the card, and asks again. */
  onFindingGone: () => void;
  /** A call changed the Proposals (or may have): the panel asks for them again. */
  onProposalsChanged: () => void;
  /** The server said the person's Role is too low: ask who they are again. */
  refreshMe: () => void;
  onSessionEnded: () => void;
}) {
  const { finding, role, getToken } = props;
  const titleId = `detail-card-${finding.id}`;
  const candidateCount = finding.unconfirmed_fix?.candidates.length ?? 0;
  const secret = finding.evidence.secret;

  const lead = role !== null && atLeast(role, "lead");
  const decisions = lead ? decisionsFor(finding) : [];
  const proposalsState =
    props.proposals === "loading"
      ? "loading"
      : props.proposals.kind === "proposals"
        ? "listed"
        : "failed";
  const pending =
    props.proposals !== "loading" && props.proposals.kind === "proposals"
      ? props.proposals.proposals.filter((p) => p.finding_id === finding.id)
      : [];
  // A Finding takes one pending Proposal at a time: while one waits, the waiting line stands in a Member's Propose
  // buttons' place. Neither shows while the Proposals load; when they couldn't load, the buttons do (the server's 409
  // is the backstop).
  const memberProposes = role === "member" ? proposalsFor(finding) : [];
  const waiting = memberProposes.length > 0 && proposalsState === "listed" && pending.length > 0;
  const proposes = proposalsState === "loading" || waiting ? [] : memberProposes;
  const mergeable = mergeableCandidates(finding, props.candidates);

  const [form, setForm] = useState<Action | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [running, setRunning] = useState<string | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  /** Counts the forms that closed because their action went away; each moves focus once, in the effect below. */
  const [closedAway, setClosedAway] = useState(0);
  const runningNow = useRef(false);
  const cardRef = useRef<HTMLElement>(null);
  /** What takes focus once the next render lands: the line, the open form's reason, or an opener (by its key). */
  const focusNext = useRef<string | null>(null);
  const refocused = useRef(0);

  // A form whose action the card no longer offers closes: the Finding's Status changed (a 409, then the page's new
  // answer), the person's Role was lowered, a Proposal now waits on the Finding, or the Proposal left the list. Its
  // refusal line stays, in the card. A Propose form stays open while the Proposals load again (a Retry), with its
  // reason.
  const offered =
    form === null ||
    (form.kind === "decide" && decisions.includes(form.decision)) ||
    (form.kind === "propose" && !waiting && memberProposes.includes(form.decision)) ||
    (form.kind === "reject" && lead && pending.some((p) => p.id === form.proposal));
  if (!offered) {
    setForm(null);
    setClosedAway((n) => n + 1);
  }

  useEffect(() => {
    const target = focusNext.current;
    const card = cardRef.current;
    focusNext.current = null;
    if (card === null) return;
    // The card's own line, never the Fix PR section's, which keeps its own focus.
    const cardLineElement = () => card.querySelector<HTMLElement>(":scope > .card-line");
    // Focus that sat in a form which went away would fall to <body>: it goes to the line, or the first button left.
    if (closedAway !== refocused.current) {
      refocused.current = closedAway;
      const active = document.activeElement;
      if (target === null && (active === null || active === document.body)) {
        (cardLineElement() ?? card.querySelector<HTMLElement>("[data-opener]"))?.focus();
      }
    }
    if (target === null) return;
    const element =
      target === "line"
        ? cardLineElement()
        : target === "reason"
          ? card.querySelector<HTMLElement>(".decision-form textarea")
          : [...card.querySelectorAll<HTMLElement>("[data-opener]")].find(
              (el) => el.dataset.opener === target,
            );
    element?.focus();
  });

  /**
   * Renew acceptance opens with the current acceptance reason, to edit; every other form opens empty. Reopens on stays
   * empty: picking the next day is what renewing is for. Set once, here: a refusal keeps what the person typed.
   */
  function draftFor(action: Action): Draft {
    return action.kind === "decide" && renews(action.decision, finding)
      ? { ...EMPTY_DRAFT, reason: finding.accepted_reason ?? "" }
      : EMPTY_DRAFT;
  }

  function open(action: Action) {
    setForm(action);
    setDraft(draftFor(action));
    setLine(null);
    focusNext.current = "reason";
  }

  function cancel() {
    if (form !== null) focusNext.current = keyOf(form);
    setForm(null);
    setLine(null);
  }

  function done(text: string) {
    setLine({ kind: "done", text });
    focusNext.current = "line";
  }

  /** One call at a time: its control is busy while it runs, and a second press sends nothing. */
  async function run<T>(action: Action, call: () => Promise<ActionResult<T>>, onDone: () => void) {
    if (runningNow.current) return;
    const key = keyOf(action);
    runningNow.current = true;
    setRunning(key);
    setLine(null);
    const result = await call();
    runningNow.current = false;
    setRunning(null);
    if (result.kind === "done") {
      // Only its own form closes: another one the person opened stays, with what they typed.
      setForm((open) => (open !== null && keyOf(open) === key ? null : open));
      onDone();
    } else {
      refused(result, action);
    }
  }

  function refused(result: Exclude<ActionResult<unknown>, { kind: "done" }>, action: Action) {
    const onProposal = action.kind === "approve" || action.kind === "reject";
    let text: string;
    switch (result.kind) {
      case "session-ended":
        props.onSessionEnded();
        return;
      case "invalid":
        text = `Warden refused this: ${sentence(result.error)}`;
        break;
      case "forbidden":
        text = action.kind === "propose" ? REFUSED.proposeForbidden : REFUSED.leadOnly;
        props.refreshMe();
        break;
      case "not-found":
        if (onProposal) {
          text = REFUSED.proposalGone;
          props.onProposalsChanged();
          props.onFindingChanged();
        } else {
          // The card goes as the page asks again: the page says why.
          text = REFUSED.findingGone;
          props.onFindingGone();
        }
        break;
      case "conflict":
        // The server's words when its body has them (a Team not opened, a Proposal stale since it was asked, a
        // Proposal already waiting on the Finding).
        text =
          result.error !== null
            ? sentence(result.error)
            : onProposal
              ? REFUSED.proposalChanged
              : REFUSED.findingChanged;
        // A propose's 409 may be a Proposal already pending: the list that comes back shows it, and the waiting line.
        if (onProposal || action.kind === "propose") props.onProposalsChanged();
        props.onFindingChanged();
        break;
      case "not-answering":
        text = REFUSED.notAnswering;
        break;
      case "too-many-attempts":
        text = tryAgainIn(result.retryAfter);
        break;
    }
    setLine({ kind: "refused", text, at: keyOf(action) });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form === null || form.kind === "approve" || !ready(form)) return;
    // The too-early rule's one check, against the day now: a form open past midnight (its earliest day is then today),
    // or a day typed in before tomorrow, is refused here in the form's words, with no call.
    if (asksUntil(form) && draft.until < earliestUntil()) {
      setLine({ kind: "refused", text: REFUSED.untilPassed, at: keyOf(form) });
      return;
    }
    const reason = draft.reason.trim();
    switch (form.kind) {
      case "decide": {
        const call = decisionCall(form.decision, reason);
        void run(
          form,
          () => decide(getToken, finding.id, call),
          () => {
            done(doneWords(call));
            props.onFindingChanged();
            props.onProposalsChanged();
          },
        );
        return;
      }
      case "propose":
        void run(
          form,
          () =>
            propose(
              getToken,
              finding.id,
              form.decision === "accept"
                ? { decision: "accept", reason, until: startOfDay(draft.until) }
                : { decision: "mark_false_positive", reason },
            ),
          () => {
            done("Proposal sent. A Lead or an Admin decides.");
            props.onProposalsChanged();
          },
        );
        return;
      case "reject":
        void run(
          form,
          () => rejectProposal(getToken, form.proposal, { reason }),
          () => {
            done("Proposal rejected.");
            props.onProposalsChanged();
          },
        );
        return;
    }
  }

  function decisionCall(decision: Decision, reason: string): DecisionRequest {
    switch (decision) {
      case "accept":
        return { decision, body: { reason, until: startOfDay(draft.until) } };
      case "mark_moved":
        return { decision, body: { reason, candidate: draft.candidate ?? "" } };
      default:
        return { decision, body: { reason } };
    }
  }

  function approve(proposal: PendingProposal) {
    void run(
      { kind: "approve", proposal: proposal.id },
      () => approveProposal(getToken, proposal.id),
      () => {
        done("Proposal approved.");
        props.onProposalsChanged();
        props.onFindingChanged();
      },
    );
  }

  const earliest = earliestUntil();
  const asksUntil = (action: Action) =>
    (action.kind === "decide" || action.kind === "propose") && action.decision === "accept";
  const asksCandidate = (action: Action) =>
    action.kind === "decide" && action.decision === "mark_moved";

  function ready(action: Action): boolean {
    if (draft.reason.trim() === "") return false;
    // A day is needed; whether it's early enough is submit's check, so the button never turns off without a refusal
    // line saying why.
    if (asksUntil(action) && draft.until === "") return false;
    if (asksCandidate(action)) {
      return mergeable.some((candidate) => candidate.id === draft.candidate);
    }
    return true;
  }

  /** The open form, named for the button that opened it. */
  function formFor(action: Action, name: string, submitLabel: string) {
    const key = keyOf(action);
    return (
      <ActionForm
        name={name}
        submitLabel={submitLabel}
        findingId={finding.id}
        until={asksUntil(action) ? earliest : null}
        candidates={asksCandidate(action) ? mergeable : null}
        draft={draft}
        onDraft={(change) => setDraft((old) => ({ ...old, ...change }))}
        ready={ready(action)}
        busy={running === key}
        refusal={line?.kind === "refused" && line.at === key ? line.text : null}
        onSubmit={submit}
        onCancel={cancel}
      />
    );
  }

  const rowForm =
    form?.kind === "decide"
      ? formFor(form, decisionLabel(form.decision, finding), decisionLabel(form.decision, finding))
      : form?.kind === "propose"
        ? formFor(form, PROPOSE_LABELS[form.decision], "Propose")
        : null;
  // A refusal shows in its form while that's open; otherwise (an approve, or a form that closed) in the card.
  const cardLine =
    line === null || (line.kind === "refused" && form !== null && line.at === keyOf(form))
      ? null
      : line;

  return (
    <section className="detail-card" aria-labelledby={titleId} ref={cardRef}>
      <div className="detail-card-top">
        <code className="detail-ids">
          {shortId(finding.id)} · {MODULE_WORDS[finding.module]} · {finding.rule_id}
        </code>
        <button
          type="button"
          className="icon-button"
          aria-label="Clear the focus"
          onClick={props.onClear}
        >
          ✕
        </button>
      </div>
      <h3 id={titleId} className="detail-title">
        {finding.title}
      </h3>
      <p className="detail-status">
        <SeverityPill finding={finding} />
        <span>{STATUS_WORDS[finding.status]}</span>
        {candidateCount > 0 && (
          <span className="flag">
            {UNCONFIRMED_FIX}: {candidateCount} {candidateCount === 1 ? "candidate" : "candidates"}
          </span>
        )}
      </p>
      <dl className="detail-fields">
        <dt>Asset</dt>
        <dd>
          {ASSET_KIND_WORDS[finding.asset.kind]}{" "}
          <span className="asset-ref">{props.assetName ?? finding.asset.ref}</span>
        </dd>
        <dt>Location</dt>
        <dd>
          <code>{locationWords(finding.location)}</code>
        </dd>
        <dt>Evidence</dt>
        <dd>{finding.evidence.summary}</dd>
        {secret && (
          <>
            <dt>Secret</dt>
            {/* Only these four fields: a secret's value is never stored, and nothing else is shown. */}
            <dd>
              {secret.type} at{" "}
              <code>
                {secret.path}:{secret.line}
              </code>
              , <code>{secret.mask}</code>
            </dd>
          </>
        )}
        {finding.control && (
          <>
            <dt>Control</dt>
            <dd>
              {finding.control.catalogue} <code>{finding.control.ref}</code>
            </dd>
          </>
        )}
        {finding.status === "accepted" && finding.accepted_reason !== null && (
          <>
            <dt>Accepted because</dt>
            <dd>{finding.accepted_reason}</dd>
          </>
        )}
        {finding.status === "accepted" && finding.accepted_until !== null && (
          <>
            <dt>Reopens on</dt>
            <dd>
              <time dateTime={finding.accepted_until}>{dayWords(finding.accepted_until)}</time>
            </dd>
          </>
        )}
      </dl>
      {finding.module === "patch" && (
        // Keyed by what a decision changes, so the section asks again after one and drops the earlier ask's answer.
        <PatchSection
          key={`${finding.status} ${finding.accepted_until ?? ""}`}
          finding={finding}
          getToken={getToken}
          onSessionEnded={props.onSessionEnded}
        />
      )}
      {finding.module === "guard" && (
        // Not keyed by the Status, as the Patch section is: a 409's refusal must outlast the Status change it caused.
        // The section asks again on a new Status itself, and drops its other lines.
        <FixPrSection
          finding={finding}
          role={role}
          userId={props.userId}
          clerkUsers={props.clerkUsers}
          getToken={getToken}
          onFindingChanged={props.onFindingChanged}
          onFindingGone={props.onFindingGone}
          onSessionEnded={props.onSessionEnded}
        />
      )}
      {cardLine?.kind === "done" && (
        <p className="card-line" role="status" tabIndex={-1}>
          {cardLine.text}
        </p>
      )}
      {cardLine?.kind === "refused" && (
        <p className="card-line refused" role="alert" tabIndex={-1}>
          {cardLine.text}
        </p>
      )}
      {/* Right after a Member's Proposal is sent, its Done line says the same thing: one box, not two. A refusal
          line doesn't stand in for it. */}
      {waiting && cardLine?.kind !== "done" && (
        <p className="card-line">Waiting for a Lead or Admin to decide.</p>
      )}
      {rowForm ??
        ((decisions.length > 0 || proposes.length > 0) && (
          <div className="card-actions" role="group" aria-label="Decisions">
            {decisions.map((decision) => (
              <OpenerButton
                key={decision}
                action={{ kind: "decide", decision }}
                label={decisionLabel(decision, finding)}
                waiting={running !== null}
                onOpen={open}
              />
            ))}
            {proposes.map((decision) => (
              <OpenerButton
                key={decision}
                action={{ kind: "propose", decision }}
                label={PROPOSE_LABELS[decision]}
                waiting={running !== null}
                onOpen={open}
              />
            ))}
          </div>
        ))}
      <Proposals
        findingId={finding.id}
        state={proposalsState}
        pending={pending}
        onRetry={props.onRetryProposals}
      >
        {(proposal) => (
          <ProposalItem
            key={proposal.id}
            proposal={proposal}
            who={askedBy(proposal, props.userId, props.clerkUsers)}
          >
            {lead &&
              (form?.kind === "reject" && form.proposal === proposal.id ? (
                formFor(form, "Reject", "Reject")
              ) : (
                <div className="proposal-actions">
                  {!proposal.stale && (
                    <button
                      type="button"
                      className="primary"
                      data-opener={`approve:${proposal.id}`}
                      disabled={running !== null}
                      aria-busy={running === `approve:${proposal.id}` ? "true" : undefined}
                      onClick={() => approve(proposal)}
                    >
                      Approve
                    </button>
                  )}
                  <OpenerButton
                    action={{ kind: "reject", proposal: proposal.id }}
                    label="Reject"
                    waiting={running !== null}
                    onOpen={open}
                  />
                </div>
              ))}
          </ProposalItem>
        )}
      </Proposals>
    </section>
  );
}

/**
 * A secondary button that opens its action's form; Cancel puts focus back on it, found by `data-opener`. It waits
 * (disabled) while any of the card's calls runs.
 */
function OpenerButton(props: {
  action: Action;
  label: string;
  waiting: boolean;
  onOpen: (action: Action) => void;
}) {
  return (
    <button
      type="button"
      className="secondary"
      data-opener={keyOf(props.action)}
      disabled={props.waiting}
      onClick={() => props.onOpen(props.action)}
    >
      {props.label}
    </button>
  );
}

/**
 * A decision's, a Proposal's or a rejection's form: Reason always, asked as "Why accept this risk?" on an accept, with
 * Reopens on (from `until`, the earliest day) and its hint; the candidates on Mark moved. Its submit is disabled until
 * it's ready, and busy while its call runs.
 */
function ActionForm(props: {
  name: string;
  submitLabel: string;
  findingId: string;
  until: string | null;
  candidates: Finding[] | null;
  draft: Draft;
  onDraft: (change: Partial<Draft>) => void;
  ready: boolean;
  busy: boolean;
  refusal: string | null;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const { draft, onDraft } = props;
  const accepts = props.until !== null;
  const untilId = useId();
  const hintId = useId();
  // Esc anywhere in the form cancels it (focus back on its opener). Marked handled, so a floating panel's Esc, which
  // listens on the document, leaves the panel open.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    props.onCancel();
  }
  return (
    // noValidate: a Reopens on day under `min` would otherwise stop the submit with the browser's own bubble; submit
    // refuses it in the form's words instead. `min` stays, so the picker greys out the days before it.
    <form
      className="decision-form"
      aria-label={props.name}
      noValidate
      onSubmit={props.onSubmit}
      onKeyDown={onKeyDown}
    >
      <label className="field">
        <span className="field-label">{accepts ? "Why accept this risk?" : "Reason"}</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={draft.reason}
          onChange={(event) => onDraft({ reason: event.target.value })}
        />
      </label>
      {props.until !== null && (
        // A div, not a label: the hint sits under the input, read as its description, not as part of its name.
        <div className="field">
          <label className="field-label" htmlFor={untilId}>
            Reopens on
          </label>
          <input
            id={untilId}
            type="date"
            min={props.until}
            value={draft.until}
            aria-describedby={hintId}
            onChange={(event) => onDraft({ until: event.target.value })}
          />
          <p id={hintId} className="form-note muted">
            Warden reopens it on this date so the Team looks again.
          </p>
        </div>
      )}
      {props.candidates !== null &&
        (props.candidates.length === 0 ? (
          <p className="form-note">The candidate isn't in this view's list. Reload to see it.</p>
        ) : (
          <fieldset className="field candidates">
            <legend className="field-label">Candidate</legend>
            {props.candidates.map((candidate) => (
              <label key={candidate.id} className="candidate">
                <input
                  type="radio"
                  name={`candidate-${props.findingId}`}
                  value={candidate.id}
                  checked={draft.candidate === candidate.id}
                  onChange={() => onDraft({ candidate: candidate.id })}
                />
                <span>
                  <code>{shortId(candidate.id)}</code>
                  {" · "}
                  {candidate.title}
                  {" · "}
                  <code>{locationWords(candidate.location)}</code>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      {props.refusal !== null && (
        <p className="card-line refused" role="alert">
          {props.refusal}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={!props.ready || props.busy}
          aria-busy={props.busy ? "true" : undefined}
        >
          {props.submitLabel}
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Who asked for a Proposal: "you" for the signed-in person, "an agent", or the person's name. */
function askedBy(
  proposal: PendingProposal,
  userId: string | null,
  clerkUsers: Map<string, ClerkUser>,
): string {
  const asker = proposal.requested_by;
  if (asker.kind === "agent") return "an agent";
  if (asker.id === userId) return "you";
  return personName(asker.id, clerkUsers.get(asker.id));
}

/**
 * The focused Finding's pending Proposals: nothing while they load or when it has none; one line and Retry when they
 * couldn't load (not answering, a body that doesn't parse, 403 or 409 alike).
 */
function Proposals(props: {
  findingId: string;
  /** Loading, failed (any refusal), or listed: then `pending` holds the focused Finding's. */
  state: "loading" | "failed" | "listed";
  pending: PendingProposal[];
  onRetry: () => void;
  children: (proposal: PendingProposal) => ReactNode;
}) {
  if (props.state === "loading") return null;
  if (props.state === "failed") {
    return (
      <p className="proposals-failed">
        <span className="muted">Couldn't load Proposals</span>
        {/* Named apart from a Patch Finding's assessment Retry, which can show in the same card. */}
        <button
          type="button"
          className="secondary"
          onClick={props.onRetry}
          aria-label="Retry Proposals"
        >
          Retry
        </button>
      </p>
    );
  }
  if (props.pending.length === 0) return null;
  const headingId = `proposals-${props.findingId}`;
  return (
    <section className="detail-proposals" aria-labelledby={headingId}>
      <h4 id={headingId}>Pending Proposals</h4>
      <ul className="proposal-list" aria-labelledby={headingId}>
        {props.pending.map(props.children)}
      </ul>
    </section>
  );
}

function ProposalItem(props: { proposal: PendingProposal; who: string; children: ReactNode }) {
  const { proposal } = props;
  return (
    <li className="proposal">
      <p className="proposal-decision">
        {PROPOSAL_DECISION_WORDS[proposal.decision]}
        {proposal.until !== null && (
          <>
            , reopens on <time dateTime={proposal.until}>{dayWords(proposal.until)}</time>
          </>
        )}
      </p>
      <p className="proposal-reason">{proposal.reason}</p>
      <p className="proposal-asked">
        Asked by {props.who},{" "}
        <time dateTime={proposal.requested_at}>{dayAndTimeWords(proposal.requested_at)}</time>
      </p>
      {proposal.stale && (
        <p className="proposal-stale">The Finding has changed since this was asked.</p>
      )}
      {props.children}
    </li>
  );
}
