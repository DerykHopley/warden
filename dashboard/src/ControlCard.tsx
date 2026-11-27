// The Control card (spec #341, slice 7a; docs/design.md: Control detail card): the Control the Overview has focused,
// in the Ask Warden panel, read-only. Its ref, question and Catalogue credit show at once, from the Overview's row; its
// Verdict, evidence and reviews once GET /api/vouch/catalogues/:id/controls/:ref answers. Everyone in the Team sees
// the same card: the review form is slice 7b's. Every string from the server is shown as text. The panel keys it by
// Catalogue and ref, so a new Control asks again, and the earlier ask's answer is dropped.
import {
  FINDINGS_VIEW_DEFAULTS,
  findingsViewPath,
  type ControlDetail,
  type ControlReview,
} from "@warden/contracts";
import { useCallback, useId, useState } from "react";
import { tryAgainIn, type GetToken } from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { SEVERITY_WORDS } from "./finding-words.ts";
import { shownVerdict } from "./overview.ts";
import type { ControlFocus } from "./panel.ts";
import { personName, type ClerkUser } from "./person-name.ts";
import {
  CONTROL_FAILED,
  CONTROL_LOADING,
  fetchControlInTeam,
  judgeSpotLine,
  NO_CONTROL,
  NO_OPEN_FINDINGS,
  NO_REVIEWS,
  REVIEW_STATE_WORDS,
  reviewOutcomeLine,
  ruleEvidenceWords,
  VERDICT_CHANGED,
  VOUCH_VERDICT_WORDS,
  type ControlResult,
} from "./vouch.ts";
import { useWardenCall } from "./warden-call.tsx";

export function ControlCard(props: {
  focus: ControlFocus;
  /** The active Team: the read waits until the session is confirmed in it. */
  team: string | null;
  getToken: GetToken;
  /** The signed-in person's user id: their own reviews read "By you". */
  userId: string | null;
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
  const { result, refresh } = useWardenCall(call, props.onSessionEnded);
  // Retry keeps the refusal on screen while it asks again, its button busy until a new answer replaces it.
  const [retriedOn, setRetriedOn] = useState<ControlResult | null>(null);
  const retry = () => {
    if (result === "loading") return;
    setRetriedOn(result);
    refresh();
  };

  return (
    <section className="detail-card control-card" aria-labelledby={titleId}>
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
        <Detail detail={result.detail} userId={props.userId} clerkUsers={props.clerkUsers} />
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
  userId: string | null;
  clerkUsers: Map<string, ClerkUser>;
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
        <p className="control-reason">{detail.reason}</p>
        {detail.review_state === "changed_since_review" && (
          <p className="control-changed">{VERDICT_CHANGED}</p>
        )}
      </section>
      <section className="control-section" aria-labelledby={evidenceId}>
        <h4 id={evidenceId}>Evidence</h4>
        {evidence.rules.length === 0 ? (
          <p>{judgeSpotLine(evidence.judge_spot_run_at)}</p>
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
                    {SEVERITY_WORDS[finding.severity]} · {finding.asset.ref}
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
      </section>
    </>
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
