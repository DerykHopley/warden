// Setup's Agent hook section (Guard spec, story 7): an Admin issues and rotates the Team's hook token, picks its
// Privacy tier, and copies the managed-settings block Claude Code reads on each developer's laptop. The token a POST
// answers is shown once and held only in this component's state, never in storage or the address.
import { PrivacyTier, type HookSettingsBody } from "@warden/contracts";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { refusalWords, type ChangeRefused } from "./change-refused.ts";
import { dayAndTimeWords } from "./date-words.ts";
import {
  blockText,
  fetchHookSettings,
  issueHookToken,
  setPrivacyTier,
  type HookSettingsResult,
} from "./hook.ts";
import { useReportAnswered, type SectionProps } from "./setup-section.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

const ADMIN_DOES = "An Admin turns on the agent hook.";
const ONLY_ADMIN = "Only an Admin changes the agent hook.";
const COPIED = "Copied.";
const CANT_COPY = "Couldn't copy. Select the text and copy it.";

/** Each tier's name: the picker's options, short enough for a phone's closed picker (#422). */
const TIER_NAMES: Record<PrivacyTier, string> = {
  metadata: "Metadata",
  details: "Details",
  content: "Content",
};

/** Each tier and what it adds, in GLOSSARY's words ("Privacy tier"): listed under the picker, where they wrap. */
const TIER_WORDS: Record<PrivacyTier, string> = {
  metadata: "Metadata: tool names and outcomes",
  details: "Details: adds commands, file paths and URLs",
  content: "Content: adds tool output and prompts",
};

/** What takes focus once the next render lands: the confirm's Cancel, Rotate, or Copy token. */
type FocusTarget = "cancel" | "rotate" | "copy-token";
/** What a Copy button copies. */
type CopyWhat = "token" | "block";

/** Writes `text` to the clipboard: whether it took it. A browser with none, or one that refuses, didn't. */
async function copied(text: string): Promise<boolean> {
  try {
    // A page over http, or one jsdom renders, has no clipboard at all.
    if (navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type HookSectionProps = SectionProps & {
  /** Setup's one ask for the Role, which the GitHub sections' 403s share as the page opens. */
  roleChanged: () => void;
};

/**
 * An Admin's hook settings; a Lead or a Member reads who turns it on, and the hook routes are never called. Only an
 * Admin's Setup waits for the settings to answer.
 */
export function HookSection(props: HookSectionProps) {
  return props.me.role === "admin" ? (
    <HookSettings {...props} />
  ) : (
    <p className="muted">{ADMIN_DOES}</p>
  );
}

function HookSettings({
  getToken,
  me,
  onSessionEnded,
  refreshMe,
  roleChanged,
  onAnswered,
}: HookSectionProps) {
  const ask = useCallback(() => fetchHookSettings(getToken), [getToken]);
  const call = useWardenCall<HookSettingsResult>(ask, onSessionEnded);
  const { setResult } = call;
  useReportAnswered(call.result !== "loading", "hook", onAnswered);
  // A 403 as the page opens: the person's Role changed since /api/me answered, so Setup asks again, once the page has
  // rendered. A 403 on a later click asks the shell itself (`refused`): the Role may have changed again since.
  const notAdmin = call.result !== "loading" && call.result.kind === "not-admin";
  useEffect(() => {
    if (notAdmin) roleChanged();
  }, [notAdmin, roleChanged]);

  /**
   * The token the last POST answered, with when it was issued: shown this once, and put in the block in the
   * placeholder's place while the settings still describe it.
   */
  const [held, setHeld] = useState<{ token: string; issuedAt: string } | null>(null);
  const [issuing, setIssuing] = useState(false);
  // Set at the click itself, before React renders the disabled button: one POST per click.
  const issueCall = useRef(false);
  const [issueRefusal, setIssueRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The tier a PUT under way is setting: the picker shows it until the answer. */
  const [pendingTier, setPendingTier] = useState<PrivacyTier | null>(null);
  const [tierRefusal, setTierRefusal] = useState<string | null>(null);
  /** The last copy: what it copied, the text, and whether the clipboard took it. Its line shows while that text does. */
  const [copy, setCopy] = useState<{ what: CopyWhat; text: string; ok: boolean } | null>(null);

  const rotateButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copyTokenButton = useRef<HTMLButtonElement>(null);
  /** Each is set beside the state change that renders it, as the Ask Warden panel does. */
  const focusNext = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    focusNext.current = null;
    ({ cancel: cancelButton, rotate: rotateButton, "copy-token": copyTokenButton })[
      next
    ].current?.focus();
  });
  const setFocusNext = (next: FocusTarget) => {
    focusNext.current = next;
  };

  const pickerId = useId();
  const tierWordsId = useId();
  /** The id of `tier`'s line in the list under the picker. */
  const tierLineId = (tier: PrivacyTier) => `${tierWordsId}-${tier}`;
  const blockHeadingId = useId();
  const questionId = useId();

  const updateSettings = (update: (old: HookSettingsBody) => HookSettingsBody) =>
    setResult((old) =>
      old === "loading" || old.kind !== "settings"
        ? old
        : { kind: "settings", settings: update(old.settings) },
    );

  /** A refused change: a 403 asks the shell for the Role again, an ended session signs out, and `say` says the rest. */
  function refused(result: ChangeRefused, say: (words: string) => void) {
    if (result.kind === "forbidden") refreshMe();
    const words = refusalWords(result, ONLY_ADMIN);
    if (words === null) return onSessionEnded();
    say(words);
  }

  async function issue() {
    if (issueCall.current) return;
    issueCall.current = true;
    setConfirming(false);
    setIssuing(true);
    setIssueRefusal(null);
    const result = await issueHookToken(getToken, me.team);
    if (result.kind !== "issued" && result.kind !== "session-ended") {
      // Another Admin may have rotated since the settings were read, or this POST may have landed with its answer lost:
      // read them again, busy still, so the next rotation asks first when an older token still works.
      const reread = await fetchHookSettings(getToken);
      if (reread.kind === "settings") updateSettings(() => reread.settings);
    }
    issueCall.current = false;
    setIssuing(false);
    if (result.kind === "issued") {
      const { token, issued_at, previous_valid_until, managed_settings } = result.issued;
      setHeld({ token, issuedAt: issued_at });
      updateSettings((old) => ({
        ...old,
        token: { issued_at },
        previous_valid_until,
        managed_settings,
      }));
      setFocusNext("copy-token");
      return;
    }
    // "Rotate again" has gone with the confirm: focus goes back to Rotate.
    setFocusNext("rotate");
    refused(result, setIssueRefusal);
  }

  async function changeTier(tier: PrivacyTier) {
    setPendingTier(tier);
    setTierRefusal(null);
    const result = await setPrivacyTier(getToken, me.team, tier);
    setPendingTier(null);
    if (result.kind === "set") {
      updateSettings(() => result.settings);
      return;
    }
    refused(result, setTierRefusal);
  }

  async function copyText(what: CopyWhat, text: string) {
    setCopy({ what, text, ok: await copied(text) });
  }

  function cancelConfirm() {
    setConfirming(false);
    setFocusNext("rotate");
  }

  function onConfirmKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    cancelConfirm();
  }

  if (call.result === "loading") {
    return <p className="muted">Asking Warden's server about the agent hook…</p>;
  }
  if (call.result.kind === "not-admin") return <p className="muted">{ADMIN_DOES}</p>;
  if (call.result.kind !== "settings") {
    return (
      <>
        <CallRefused result={call.result} onRetry={call.retry} />
        <TeamRefused result={call.result} />
      </>
    );
  }
  const { settings } = call.result;
  // Another Admin's rotation since this page issued leaves the held token out: the block describes the newer one.
  const heldIsCurrent = held !== null && held.issuedAt === settings.token?.issued_at;
  const block = blockText(settings.managed_settings, heldIsCurrent ? held.token : null);
  const previousUntil = settings.previous_valid_until;
  // The confirm shows, and keeps Rotate disabled, only while an older token still works.
  const confirmOpen = confirming && previousUntil !== null;
  // A rotation and a tier change each answer with a block: one at a time, so the block matches the picker.
  const changing = issuing || pendingTier !== null;

  /** The last copy's line, while what `what` copies is still the text it copied. */
  const copyLine = (what: CopyWhat, text: string) =>
    copy?.what !== what || copy.text !== text ? null : copy.ok ? (
      <span className="muted" role="status">
        {COPIED}
      </span>
    ) : (
      <p className="notice" role="alert">
        {CANT_COPY}
      </p>
    );

  return (
    <div className="hook-settings">
      {settings.token === null ? (
        <p>No hook token yet.</p>
      ) : (
        <p>Hook token issued {dayAndTimeWords(settings.token.issued_at)}</p>
      )}
      {previousUntil !== null && (
        <p className="muted">The token before it works until {dayAndTimeWords(previousUntil)}.</p>
      )}
      {held !== null && (
        <div className="hook-token">
          <p>
            <code className="hook-token-value">{held.token}</code>
          </p>
          <div className="hook-copy">
            <button
              ref={copyTokenButton}
              type="button"
              className="secondary"
              onClick={() => void copyText("token", held.token)}
            >
              Copy token
            </button>
            {copyLine("token", held.token)}
          </div>
          <p className="muted">Shown this once. Copy it now: Warden keeps only its hash.</p>
        </div>
      )}
      <div className="hook-actions">
        <button
          ref={rotateButton}
          type="button"
          className={settings.token === null ? "primary" : "secondary"}
          disabled={changing || confirmOpen}
          aria-busy={issuing}
          onClick={() => {
            if (previousUntil !== null && settings.token !== null) {
              setConfirming(true);
              setFocusNext("cancel");
            } else {
              void issue();
            }
          }}
        >
          {settings.token === null ? "Issue a hook token" : "Rotate the hook token"}
        </button>
      </div>
      {confirmOpen && (
        <div
          className="delete-confirm"
          role="group"
          aria-labelledby={questionId}
          onKeyDown={onConfirmKey}
        >
          <p id={questionId} className="delete-question">
            The token before the current one still works until {dayAndTimeWords(previousUntil)}.
            Rotating again stops it at once: laptops that haven't got the current token stop
            sending.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={issuing}
              aria-busy={issuing}
              onClick={() => void issue()}
            >
              Rotate again
            </button>
            <button
              ref={cancelButton}
              type="button"
              className="secondary"
              disabled={issuing}
              onClick={cancelConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {issueRefusal !== null && (
        <p className="notice" role="alert">
          {issueRefusal}
        </p>
      )}
      <div className="hook-tier">
        <label htmlFor={pickerId}>Privacy tier</label>
        <select
          id={pickerId}
          className="role-picker"
          value={pendingTier ?? settings.privacy_tier}
          // Still while the confirm is open too, so its words and Rotate's state can't change under it.
          disabled={changing || confirmOpen}
          aria-busy={pendingTier !== null}
          // The three lines, not the list: a browser reads a described list by its label, not its lines (#436).
          aria-describedby={PrivacyTier.options.map(tierLineId).join(" ")}
          onChange={(event) => void changeTier(PrivacyTier.parse(event.target.value))}
        >
          {PrivacyTier.options.map((tier) => (
            <option key={tier} value={tier}>
              {TIER_NAMES[tier]}
            </option>
          ))}
        </select>
        <ul className="hook-tier-words muted" aria-label="What each Privacy tier sends">
          {PrivacyTier.options.map((tier) => (
            <li key={tier} id={tierLineId(tier)}>
              {TIER_WORDS[tier]}
            </li>
          ))}
        </ul>
        <p className="muted">Moving to or from Content changes the block: paste it again.</p>
      </div>
      {tierRefusal !== null && (
        <p className="notice" role="alert">
          {tierRefusal}
        </p>
      )}
      <h3 id={blockHeadingId}>Managed-settings block</h3>
      <pre className="hook-block" aria-labelledby={blockHeadingId}>
        {block}
      </pre>
      <div className="hook-copy">
        <button type="button" className="secondary" onClick={() => void copyText("block", block)}>
          Copy block
        </button>
        {copyLine("block", block)}
      </div>
    </div>
  );
}
