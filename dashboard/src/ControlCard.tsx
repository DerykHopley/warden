// The Control card (spec #341, slices 7a and 7b; docs/design.md: Control detail card): the Control the Overview has
// focused, in the Ask Warden panel. Its ref, question and Catalogue credit show at once, from the Overview's row; its
// Verdict, evidence and reviews once GET /api/vouch/catalogues/:id/controls/:ref answers, a Product Asset named from
// GET /api/products, as on Findings. A read newer than the row asks the Overview to read it again. Under Reviews, a Lead
// or an Admin confirms or overrides the Verdict (POST .../reviews), one review per submit; a Member reads who reviews
// it. Every string from the server is shown as text. The panel keys it by Catalogue and ref, so a new Control asks
// again, and the earlier ask's answer, or a review's, shows on no card.
import {
  atLeast,
  FINDINGS_VIEW_DEFAULTS,
  findingsViewPath,
  ReviewedVerdict,
  type ControlDetail,
  type ControlReview,
  type Product,
  type ReviewBody,
  type Role,
} from "@warden/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { NOT_ANSWERING, sentence, TEAM_NOT_OPENED, tryAgainIn, type GetToken } from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { DecisionForm, focusInCard, OpenerButton, type FocusTarget } from "./decision-form.tsx";
import { SEVERITY_WORDS } from "./finding-words.ts";
import { assetLabel } from "./findings.ts";
import { rowAgrees, shownVerdict } from "./overview.ts";
import type { ControlFocus } from "./panel.ts";
import { personName, type ClerkUser } from "./person-name.ts";
import { askProducts, type ProductsResult } from "./products.ts";
import {
  CONTROL_FAILED,
  CONTROL_LOADING,
  fetchControlInTeam,
  judgeRunLine,
  MAYBE_REVIEWED,
  MEMBER_REVIEWS,
  NO_CONTROL,
  NO_OPEN_FINDINGS,
  NO_REVIEWS,
  REVIEW_FORBIDDEN,
  REVIEW_REFUSED,
  REVIEW_STATE_WORDS,
  reviewControlInTeam,
  reviewDoneWords,
  reviewOutcomeLine,
  ruleEvidenceWords,
  verdictReasonLine,
  VERDICT_CHANGED,
  VOUCH_VERDICT_WORDS,
  type ControlResult,
} from "./vouch.ts";
import { useWardenCall } from "./warden-call.tsx";

/** The review form that is open: Confirm's or Override's. */
type ReviewForm = "confirm" | "override";
/** The card's line under Reviews: a review's Done line, or why it was refused. */
type Line = { kind: "done" | "refused"; text: string };
/** The card's Done line, which takes focus after a review. */
const doneLine = (card: HTMLElement) =>
  card.querySelector<HTMLElement>(".card-line[role='status']");

export function ControlCard(props: {
  focus: ControlFocus;
  /** The active Team: the read waits until the session is confirmed in it, and so does a review. */
  team: string | null;
  getToken: GetToken;
  /** The signed-in person's user id: their own reviews read "By you". */
  userId: string | null;
  /** The person's Role: a Lead or an Admin reviews; null until /api/me answers, and nothing shows. */
  role: Role | null;
  /** Asks /api/me again: after a 403, so a lowered Role loses the form. */
  refreshMe: () => void;
  clerkUsers: Map<string, ClerkUser>;
  onClear: () => void;
  onSessionEnded: () => void;
}) {
  const { focus, team, getToken } = props;
  const { catalogue, control } = focus;
  const titleId = useId();
  const call = useCallback(
    () => fetchControlInTeam(getToken, team, catalogue.id, control.ref),
    [getToken, team, catalogue.id, control.ref],
  );
  const { result, setResult, refresh } = useWardenCall(call, props.onSessionEnded);
  // A read newer than the Overview's row asks for the row again, once per read, so the two say the same. A review's
  // answer asks for the row itself, so the read it brings (its 201's, or the one asked after no answer) asks nothing.
  const { refreshRow } = focus;
  const compared = useRef<ControlResult | null>(null);
  const rowAskedFor = useRef(false);
  useEffect(() => {
    if (result === "loading" || compared.current === result) return;
    compared.current = result;
    if (rowAskedFor.current) {
      rowAskedFor.current = false;
      return;
    }
    if (result.kind === "control" && !rowAgrees(control, result.detail)) refreshRow();
  }, [result, control, refreshRow]);
  // A Product Asset's Finding is named by its Product, as on Findings.
  const listProducts = useCallback(
    (signal: AbortSignal) => askProducts(getToken, team, signal),
    [getToken, team],
  );
  const productsCall = useWardenCall<ProductsResult>(listProducts, props.onSessionEnded);
  const products =
    productsCall.result !== "loading" && productsCall.result.kind === "products"
      ? productsCall.result.products
      : null;
  // Retry keeps the refusal on screen while it asks again, its button busy until a new answer replaces it.
  const [retriedOn, setRetriedOn] = useState<ControlResult | null>(null);
  const retry = () => {
    if (result === "loading") return;
    setRetriedOn(result);
    refresh();
  };

  // The review form: a Lead's or an Admin's, one open at a time, in place of the row of buttons that opens it.
  const canReview = props.role !== null && atLeast(props.role, "lead");
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [reason, setReason] = useState("");
  const [verdict, setVerdict] = useState<ReviewedVerdict | null>(null);
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<Line | null>(null);
  /** Set at the click, before React renders the busy submit: a second press in the same tick sends nothing. */
  const sendingNow = useRef(false);
  /**
   * After no answer, the read the card showed then: until a newer one replaces it, the form waits as while sending,
   * so a second review's answer can't land before that read and be replaced by it.
   */
  const [rereadFrom, setRereadFrom] = useState<ControlResult | "loading" | null>(null);
  const waiting = sending || rereadFrom === result;
  // A Role lowered (a 403, then /api/me again) closes the form; its refusal line stays, in the card.
  if (!canReview && form !== null) setForm(null);
  // A read that works out the picked Verdict drops it: its radio has gone, and the override would change nothing.
  const workedOut =
    result !== "loading" && result.kind === "control" ? result.detail.verdict : null;
  if (verdict !== null && verdict === workedOut) setVerdict(null);

  const cardRef = useRef<HTMLElement>(null);
  /** What takes focus once the next render lands: the open form's first field, the Done line, or an opener. */
  const focusNext = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    const card = cardRef.current;
    focusNext.current = null;
    if (target !== null && card !== null) focusInCard(card, target, doneLine);
  });

  function open(next: ReviewForm) {
    setForm(next);
    setReason("");
    setVerdict(null);
    setLine(null);
    focusNext.current = "field";
  }

  /** Not while a review is sending, or the read after no answer runs: the form stays for its answer. */
  function cancel() {
    if (waiting) return;
    if (form !== null) focusNext.current = form;
    setForm(null);
    setLine(null);
  }

  const refused = (text: string) => setLine({ kind: "refused", text });

  /**
   * One review per submit: sent once /api/me confirms the Team the card was opened in. Its answer may land after the
   * card has gone (✕, or another Control focused): the card's own state is then dropped with it, and only the row of
   * the focus it was sent from is asked for again.
   */
  async function send(body: ReviewBody) {
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    setLine(null);
    const shown = result;
    const answer = await reviewControlInTeam(getToken, team, catalogue.id, control.ref, body);
    sendingNow.current = false;
    setSending(false);
    switch (answer.kind) {
      case "reviewed":
        rowAskedFor.current = true;
        setResult(() => ({ kind: "control", detail: answer.detail }));
        setForm(null);
        setLine({ kind: "done", text: reviewDoneWords(body) });
        focusNext.current = "line";
        refreshRow();
        return;
      case "maybe-saved":
        refused(MAYBE_REVIEWED);
        rowAskedFor.current = true;
        setRereadFrom(shown);
        refresh();
        refreshRow();
        return;
      case "session-ended":
        props.onSessionEnded();
        return;
      case "forbidden":
        refused(REVIEW_FORBIDDEN);
        props.refreshMe();
        return;
      case "refused":
        refused(answer.error === null ? REVIEW_REFUSED : sentence(answer.error));
        return;
      case "team-not-opened":
        refused(TEAM_NOT_OPENED);
        return;
      case "too-many-attempts":
      case "too-many-sign-ins":
        refused(tryAgainIn(answer.retryAfter));
        return;
      case "not-answering":
        refused(NOT_ANSWERING);
        return;
    }
  }

  const trimmed = reason.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (form === "confirm") {
      void send(trimmed === "" ? { outcome: "confirm" } : { outcome: "confirm", reason: trimmed });
    } else if (form === "override" && verdict !== null && trimmed !== "") {
      void send({ outcome: "override", verdict, reason: trimmed });
    }
  }

  const refusal = line?.kind === "refused" ? line.text : null;
  const reviewing = (worked: ControlDetail["verdict"]): ReactNode => (
    <>
      {line?.kind === "done" && (
        <p className="card-line" role="status" tabIndex={-1}>
          {line.text}
        </p>
      )}
      {refusal !== null && form === null && (
        <p className="card-line refused" role="alert">
          {refusal}
        </p>
      )}
      {props.role === null ? null : !canReview ? (
        <p className="muted control-member">{MEMBER_REVIEWS}</p>
      ) : form === null ? (
        <div className="card-actions" role="group" aria-label="Review">
          <OpenerButton
            opener="confirm"
            label="Confirm"
            waiting={waiting}
            onOpen={() => open("confirm")}
          />
          <OpenerButton
            opener="override"
            label="Override"
            waiting={waiting}
            onOpen={() => open("override")}
          />
        </div>
      ) : (
        <ReviewFormFields
          form={form}
          worked={worked}
          reason={reason}
          onReason={setReason}
          verdict={verdict}
          onVerdict={setVerdict}
          ready={form === "confirm" || (verdict !== null && trimmed !== "")}
          busy={waiting}
          refusal={refusal}
          onSubmit={submit}
          onCancel={cancel}
        />
      )}
    </>
  );

  return (
    <section ref={cardRef} className="detail-card control-card" aria-labelledby={titleId}>
      <div className="detail-card-top">
        <code className="detail-ids">{control.ref}</code>
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
        {control.question}
      </h3>
      <p className="muted">{catalogue.credit}</p>
      <p className="muted catalogue-licence">
        Licence:{" "}
        <a href={catalogue.licence_url} target="_blank" rel="noreferrer">
          {catalogue.licence}
        </a>
      </p>
      {result === "loading" ? (
        <p className="muted">{CONTROL_LOADING}</p>
      ) : result.kind === "control" ? (
        <Detail
          detail={result.detail}
          products={products}
          userId={props.userId}
          clerkUsers={props.clerkUsers}
          reviewing={reviewing(result.detail.verdict)}
        />
      ) : result.kind === "not-found" ? (
        <p className="muted">{result.error ?? NO_CONTROL}</p>
      ) : result.kind === "session-ended" ? null : (
        <p className="control-failed">
          <span className="muted">
            {result.kind === "too-many-attempts" ? tryAgainIn(result.retryAfter) : CONTROL_FAILED}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={retry}
            disabled={retriedOn === result}
            aria-busy={retriedOn === result}
            aria-label="Retry the Control"
          >
            Retry
          </button>
        </p>
      )}
    </section>
  );
}

/** The read Control: its Verdict, its evidence and its reviews, each under its heading. */
function Detail(props: {
  detail: ControlDetail;
  /** The Team's Products, which name a Product Asset; null until they answer, and the ref shows. */
  products: readonly Product[] | null;
  userId: string | null;
  clerkUsers: Map<string, ClerkUser>;
  /** Under the reviews: the review form, its row of buttons and its lines, or a Member's line. */
  reviewing: ReactNode;
}) {
  const { detail } = props;
  const { evidence } = detail;
  const verdictId = useId();
  const evidenceId = useId();
  const findingsId = useId();
  const reviewsId = useId();
  return (
    <>
      <section className="control-section" aria-labelledby={verdictId}>
        <h4 id={verdictId}>Verdict</h4>
        <p className="control-verdict">
          <strong>{VOUCH_VERDICT_WORDS[shownVerdict(detail)]}</strong> ·{" "}
          <span>{REVIEW_STATE_WORDS[detail.review_state]}</span>
        </p>
        <p className="control-reason">{verdictReasonLine(detail)}</p>
        {detail.review_state === "changed_since_review" && (
          <p className="control-changed">{VERDICT_CHANGED}</p>
        )}
      </section>
      <section className="control-section" aria-labelledby={evidenceId}>
        <h4 id={evidenceId}>Evidence</h4>
        {evidence.rules.length === 0 ? (
          <p>{judgeRunLine(evidence.judge_spot_run_at)}</p>
        ) : (
          <ul className="control-rules">
            {evidence.rules.map((rule) => (
              <li key={rule.rule_id}>
                <code>{rule.rule_id}</code>: {ruleEvidenceWords(rule)}
              </li>
            ))}
          </ul>
        )}
        <h5 id={findingsId}>Open Findings</h5>
        {evidence.open_findings.length === 0 ? (
          <p className="muted">{NO_OPEN_FINDINGS}</p>
        ) : (
          <ul className="control-findings" aria-labelledby={findingsId}>
            {evidence.open_findings.map((finding) => (
              <li key={finding.id}>
                <a href={findingsViewPath({ ...FINDINGS_VIEW_DEFAULTS, finding: finding.id })}>
                  <span className="control-finding-title">{finding.title}</span>{" "}
                  <span className="muted">
                    {SEVERITY_WORDS[finding.severity]} · {assetLabel(finding.asset, props.products)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="control-section" aria-labelledby={reviewsId}>
        <h4 id={reviewsId}>Reviews</h4>
        {detail.reviews.length === 0 ? (
          <p className="muted">{NO_REVIEWS}</p>
        ) : (
          <ol className="control-reviews" aria-labelledby={reviewsId}>
            {detail.reviews.map((review) => (
              <ReviewItem
                key={review.id}
                review={review}
                who={reviewedBy(review, props.userId, props.clerkUsers)}
              />
            ))}
          </ol>
        )}
        {props.reviewing}
      </section>
    </>
  );
}

/**
 * Confirm's form (an optional Reason) or Override's (the Verdict, from every reviewed Verdict but the worked-out one,
 * and a required Reason), in the Finding card's decision form frame. Its submit is disabled until it's ready, and busy
 * while the review runs; Esc cancels it, but not while the review runs.
 */
function ReviewFormFields(props: {
  form: ReviewForm;
  /** The read's worked-out Verdict: an override must change it, so it isn't offered. */
  worked: ControlDetail["verdict"];
  reason: string;
  onReason: (reason: string) => void;
  verdict: ReviewedVerdict | null;
  onVerdict: (verdict: ReviewedVerdict) => void;
  ready: boolean;
  busy: boolean;
  refusal: string | null;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const radios = useId();
  const confirms = props.form === "confirm";
  const label = confirms ? "Confirm" : "Override";
  return (
    <DecisionForm
      name={`${label} the Verdict`}
      submitLabel={label}
      ready={props.ready}
      busy={props.busy}
      holdWhileBusy
      refusal={props.refusal}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
    >
      {!confirms && (
        <fieldset className="field candidates">
          <legend className="field-label">Verdict</legend>
          {ReviewedVerdict.options
            .filter((option) => option !== props.worked)
            .map((option) => (
              <label key={option} className="candidate">
                <input
                  type="radio"
                  name={radios}
                  value={option}
                  checked={props.verdict === option}
                  onChange={() => props.onVerdict(option)}
                />
                <span>{VOUCH_VERDICT_WORDS[option]}</span>
              </label>
            ))}
        </fieldset>
      )}
      <label className="field">
        <span className="field-label">{confirms ? "Reason (optional)" : "Reason"}</span>
        <textarea
          rows={3}
          maxLength={2000}
          aria-required={confirms ? undefined : "true"}
          value={props.reason}
          onChange={(event) => props.onReason(event.target.value)}
        />
      </label>
    </DecisionForm>
  );
}

/** Who reviewed: "you" for the signed-in person, else the person's name. */
function reviewedBy(
  review: ControlReview,
  userId: string | null,
  clerkUsers: Map<string, ClerkUser>,
): string {
  if (review.reviewed_by === userId) return "you";
  return personName(review.reviewed_by, clerkUsers.get(review.reviewed_by));
}

function ReviewItem({ review, who }: { review: ControlReview; who: string }) {
  return (
    <li className="control-review">
      <p className="control-review-outcome">{reviewOutcomeLine(review)}</p>
      {review.reason !== null && <p className="control-review-reason">{review.reason}</p>}
      <p className="control-review-by">
        By {who}, <time dateTime={review.reviewed_at}>{dayAndTimeWords(review.reviewed_at)}</time>
      </p>
    </li>
  );
}
