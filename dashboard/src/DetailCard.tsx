// The detail card (docs/design.md: Side panel): the Finding the page has focused, above the chat, in its own tint, with
// its own ✕. Its fields, then its pending Proposals, each its own list item. Read-only here; a Lead's decision buttons
// join the card and each Proposal later, so nothing in this markup assumes it stays read-only.
import type { Finding, PendingProposal } from "@warden/contracts";
import {
  ASSET_KIND_WORDS,
  locationWords,
  MODULE_WORDS,
  PROPOSAL_DECISION_WORDS,
  STATUS_WORDS,
  UNCONFIRMED_FIX,
} from "./finding-words.ts";
import { shortId } from "./findings.ts";
import { personName, type ClerkUser } from "./person-name.ts";
import type { ProposalsResult } from "./proposals.ts";
import { SeverityPill } from "./SeverityPill.tsx";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const dayAndTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function DetailCard(props: {
  finding: Finding;
  /** The Team's pending Proposals, or loading. Only the focused Finding's show. */
  proposals: ProposalsResult | "loading";
  clerkUsers: Map<string, ClerkUser>;
  /** The card's ✕: clears the page's focus. */
  onClear: () => void;
}) {
  const { finding } = props;
  const titleId = `detail-card-${finding.id}`;
  const candidates = finding.unconfirmed_fix?.candidates.length ?? 0;
  const secret = finding.evidence.secret;

  return (
    <section className="detail-card" aria-labelledby={titleId}>
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
        {candidates > 0 && (
          <span className="flag">
            {UNCONFIRMED_FIX}: {candidates} {candidates === 1 ? "candidate" : "candidates"}
          </span>
        )}
      </p>
      <dl className="detail-fields">
        <dt>Asset</dt>
        <dd>
          {ASSET_KIND_WORDS[finding.asset.kind]}{" "}
          <span className="asset-ref">{finding.asset.ref}</span>
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
            <dt>Until</dt>
            <dd>
              <time dateTime={finding.accepted_until}>{day(finding.accepted_until)}</time>
            </dd>
          </>
        )}
      </dl>
      <Proposals findingId={finding.id} proposals={props.proposals} clerkUsers={props.clerkUsers} />
    </section>
  );
}

/** The focused Finding's pending Proposals: nothing while they load or when it has none; one line when they failed. */
function Proposals(props: {
  findingId: string;
  proposals: ProposalsResult | "loading";
  clerkUsers: Map<string, ClerkUser>;
}) {
  if (props.proposals === "loading") return null;
  if (props.proposals.kind !== "proposals") {
    return <p className="muted">Couldn't load Proposals</p>;
  }
  const mine = props.proposals.proposals.filter((p) => p.finding_id === props.findingId);
  if (mine.length === 0) return null;
  const headingId = `proposals-${props.findingId}`;
  return (
    <section className="detail-proposals" aria-labelledby={headingId}>
      <h4 id={headingId}>Pending Proposals</h4>
      <ul className="proposal-list" aria-labelledby={headingId}>
        {mine.map((proposal) => (
          <ProposalItem key={proposal.id} proposal={proposal} clerkUsers={props.clerkUsers} />
        ))}
      </ul>
    </section>
  );
}

function ProposalItem({
  proposal,
  clerkUsers,
}: {
  proposal: PendingProposal;
  clerkUsers: Map<string, ClerkUser>;
}) {
  const asker = proposal.requested_by;
  const who = asker.kind === "agent" ? "an agent" : personName(asker.id, clerkUsers.get(asker.id));
  return (
    <li className="proposal">
      <p className="proposal-decision">
        {PROPOSAL_DECISION_WORDS[proposal.decision]}
        {proposal.until !== null && (
          <>
            {" "}
            until <time dateTime={proposal.until}>{day(proposal.until)}</time>
          </>
        )}
      </p>
      <p className="proposal-reason">{proposal.reason}</p>
      <p className="proposal-asked">
        Asked by {who},{" "}
        <time dateTime={proposal.requested_at}>{dayAndTime(proposal.requested_at)}</time>
      </p>
      {proposal.stale && (
        <p className="proposal-stale">The Finding has changed since this was asked.</p>
      )}
    </li>
  );
}
