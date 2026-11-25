// The detail card's Patch section (docs/design.md: Patch section (Detail card)): a Patch Finding's assessment, asked
// when the card opens on it. Whether its version is affected and why, what fixes it, who acts, how urgent it is and
// when it's due (while it's Open or Accepted), and its NVD and OSV pages. Every string from the server is shown as
// text; a page that isn't https: is never a link. DetailCard keys it by the Finding's Status and acceptance, so a
// decision asks again, and the earlier ask's answer is dropped.
import type { Finding, PatchAssessment } from "@warden/contracts";
import { useCallback, useId, useState } from "react";
import { tryAgainIn, type GetToken } from "./api.ts";
import {
  ASSESSMENT_FAILED,
  ASSESSMENT_LOADING,
  assessmentLinks,
  dueDayWords,
  fetchAssessmentInTeam,
  LEVEL_WORDS,
  NO_ASSESSMENT,
  NO_FIX,
  NO_FIX_FOR_PACKAGE,
  NO_ONE_ACTS,
  VERDICT_WORDS,
  WHO_ACTS_WORDS,
  type AssessmentResult,
} from "./patch.ts";
import { useWardenCall } from "./warden-call.tsx";

export function PatchSection(props: {
  finding: Finding;
  getToken: GetToken;
  onSessionEnded: () => void;
}) {
  const { finding, getToken } = props;
  const headingId = useId();
  const call = useCallback(
    () => fetchAssessmentInTeam(getToken, finding.team, finding.id),
    [getToken, finding.team, finding.id],
  );
  const { result, refresh } = useWardenCall(call, props.onSessionEnded);
  // Retry keeps the refusal on screen while it asks again, its button busy until a new answer replaces it.
  const [retriedOn, setRetriedOn] = useState<AssessmentResult | null>(null);
  const retry = () => {
    if (result === "loading") return;
    setRetriedOn(result);
    refresh();
  };

  return (
    <section className="patch-section" aria-labelledby={headingId}>
      <h4 id={headingId}>Patch</h4>
      {result === "loading" ? (
        <p className="muted">{ASSESSMENT_LOADING}</p>
      ) : result.kind === "assessment" ? (
        <Assessment assessment={result.assessment} status={finding.status} />
      ) : result.kind === "not-found" ? (
        <p className="muted">{result.error ?? NO_ASSESSMENT}</p>
      ) : result.kind === "session-ended" ? null : (
        <p className="patch-failed">
          <span className="muted">
            {result.kind === "too-many-attempts"
              ? tryAgainIn(result.retryAfter)
              : ASSESSMENT_FAILED}
          </span>
          {/* Named apart from the Proposals' Retry, which can show in the same card. */}
          <button
            type="button"
            className="secondary"
            onClick={retry}
            disabled={retriedOn === result}
            aria-busy={retriedOn === result}
            aria-label="Retry the CVE assessment"
          >
            Retry
          </button>
        </p>
      )}
    </section>
  );
}

function Assessment({
  assessment,
  status,
}: {
  assessment: PatchAssessment;
  status: Finding["status"];
}) {
  const { priority } = assessment;
  const links = assessmentLinks(assessment.links);
  return (
    <dl className="detail-fields">
      <dt>Your version</dt>
      <dd>
        <strong>{VERDICT_WORDS[assessment.verdict]}</strong>{" "}
        <span className="patch-reason">{assessment.reason}</span>
      </dd>
      <dt>Fixed in</dt>
      <dd>
        {assessment.fixes.length > 1 ? (
          <ul className="patch-list">
            {assessment.fixes.map((fix, i) => (
              <li key={i}>
                {fix.package}: {fix.fixed_version ?? NO_FIX_FOR_PACKAGE}
              </li>
            ))}
          </ul>
        ) : (
          (assessment.fixed_version ?? NO_FIX)
        )}
      </dd>
      <dt>Who acts</dt>
      <dd>{assessment.who_acts === null ? NO_ONE_ACTS : WHO_ACTS_WORDS[assessment.who_acts]}</dd>
      {(status === "open" || status === "accepted") && (
        <>
          <dt>Priority</dt>
          <dd>
            <strong>{LEVEL_WORDS[priority.level]}</strong>
            {priority.overdue && <span className="flag">Overdue</span>}
            {priority.reasons.length > 0 && (
              <ul className="patch-list">
                {priority.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            )}
            <p className="patch-due">
              Due {dueDayWords(priority.due_date)} ({priority.due_from})
            </p>
          </dd>
        </>
      )}
      {links.length > 0 && (
        <>
          <dt>Links</dt>
          <dd>
            <ul className="patch-links">
              {links.map((link) => (
                <li key={link.name}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}
