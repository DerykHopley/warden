// Setup's Agent hook section (Guard spec, story 7): an Admin issues and rotates the Team's hook token, picks its
// Privacy tier, and copies the managed-settings block Claude Code reads on each developer's laptop. The token a POST
// answers is shown once and held only in this component's state, never in storage or the address.
import { PrivacyTier, type HookSettingsBody } from "@warden/contracts";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { NOT_ANSWERING, TEAM_NOT_OPENED, tryAgainIn } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { dayAndTimeWords } from "./date-words.ts";
import {
  blockText,
  fetchHookSettings,
  issueHookToken,
  setPrivacyTier,
  type HookSettingsResult,
  type IssueResult,
  type TierResult,
} from "./hook.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

const ADMIN_DOES = "An Admin turns on the agent hook.";
const ONLY_ADMIN = "Only an Admin changes the agent hook.";
const COPIED = "Copied.";
const CANT_COPY = "Couldn't copy. Select the text and copy it.";

/** Each tier and what it adds, in GLOSSARY's words ("Privacy tier"). */
const TIER_WORDS: Record<PrivacyTier, string> = {
  metadata: "Metadata: tool names and outcomes",
  details: "Details: adds commands, file paths and URLs",
  content: "Content: adds tool output and prompts",
};

/** A refused change in words, or null for a session that ended (the shell signs out). */
function refusalWords(
  result: Exclude<IssueResult | TierResult, { kind: "issued" | "set" }>,
): string | null {
  switch (result.kind) {
    case "forbidden":
      return ONLY_ADMIN;
    case "refused":
      return result.words;
    case "team-not-opened":
      return TEAM_NOT_OPENED;
    case "too-many-attempts":
    case "too-many-sign-ins":
      return tryAgainIn(result.retryAfter);
    case "not-answering":
      return NOT_ANSWERING;
    case "session-ended":
      return null;
  }
}

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

type HookSectionProps = PageProps & { onAnswered: () => void };

/**
 * An Admin's hook settings; a Lead or a Member reads who turns it on, and the hook routes are never called. `onAnswered`
 * tells Setup the settings have answered: only an Admin's Setup waits for them.
 */
export function HookSection(props: HookSectionProps) {
  return props.me.role === "admin" ? (
    <HookSettings {...props} />
  ) : (
    <p className="muted">{ADMIN_DOES}</p>
  );
}

function HookSettings({ getToken, me, onSessionEnded, refreshMe, onAnswered }: HookSectionProps) {
  const ask = useCallback(() => fetchHookSettings(getToken), [getToken]);
  const call = useWardenCall<HookSettingsResult>(ask, onSessionEnded);
  const { setResult } = call;
  const answered = call.result !== "loading";
  useEffect(() => {
    if (answered) onAnswered();
  }, [answered, onAnswered]);
  // A 403: the person's Role changed since /api/me answered, so the shell asks again, once the page has rendered.
  const notAdmin = call.result !== "loading" && call.result.kind === "not-admin";
  useEffect(() => {
    if (notAdmin) refreshMe();
  }, [notAdmin, refreshMe]);

  /** The token the last POST answered: shown this once, and put in the block in the placeholder's place. */
  const [heldToken, setHeldToken] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  // Set at the click itself, before React renders the disabled button: one POST per click.
  const issueCall = useRef(false);
  const [issueRefusal, setIssueRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The tier a PUT under way is setting: the picker shows it until the answer. */
  const [pendingTier, setPendingTier] = useState<PrivacyTier | null>(null);
  const [tierRefusal, setTierRefusal] = useState<string | null>(null);
  /** The last copy, by what it copied: whether the clipboard took it. */
  const [copy, setCopy] = useState<{ what: "token" | "block"; ok: boolean } | null>(null);

  const rotateButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copyTokenButton = useRef<HTMLButtonElement>(null);
  /**
   * What takes focus once the next render lands: the confirm's Cancel, Rotate, or Copy token. Each is set beside the
   * state change that renders it, as the Ask Warden panel does.
   */
  const focusNext = useRef<"cancel" | "rotate" | "copy-token" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    focusNext.current = null;
    ({ cancel: cancelButton, rotate: rotateButton, "copy-token": copyTokenButton })[
      next
    ].current?.focus();
  });
  const setFocusNext = (next: "cancel" | "rotate" | "copy-token") => {
    focusNext.current = next;
  };

  const pickerId = useId();
  const blockHeadingId = useId();
  const questionId = useId();

  const updateSettings = (update: (old: HookSettingsBody) => HookSettingsBody) =>
    setResult((old) =>
      old === "loading" || old.kind !== "settings"
        ? old
        : { kind: "settings", settings: update(old.settings) },
    );

  async function issue() {
    if (issueCall.current) return;
    issueCall.current = true;
    setConfirming(false);
    setIssuing(true);
    setIssueRefusal(null);
    const result = await issueHookToken(getToken, me.team);
    issueCall.current = false;
    setIssuing(false);
    if (result.kind === "issued") {
      const { token, issued_at, previous_valid_until, managed_settings } = result.issued;
      setHeldToken(token);
      setCopy(null);
      updateSettings((old) => ({
        ...old,
        token: { issued_at },
        previous_valid_until,
        managed_settings,
      }));
      setFocusNext("copy-token");
      return;
    }
    if (result.kind === "forbidden") refreshMe();
    const words = refusalWords(result);
    if (words === null) return onSessionEnded();
    setIssueRefusal(words);
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
    if (result.kind === "forbidden") refreshMe();
    const words = refusalWords(result);
    if (words === null) return onSessionEnded();
    setTierRefusal(words);
  }

  async function copyText(what: "token" | "block", text: string) {
    setCopy({ what, ok: await copied(text) });
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
  const block = blockText(settings.managed_settings, heldToken);
  const previousUntil = settings.previous_valid_until;

  const copyLine = (what: "token" | "block") =>
    copy?.what !== what ? null : copy.ok ? (
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
      {heldToken !== null && (
        <div className="hook-token">
          <p>
            <code className="hook-token-value">{heldToken}</code>
          </p>
          <div className="hook-copy">
            <button
              ref={copyTokenButton}
              type="button"
              className="secondary"
              onClick={() => void copyText("token", heldToken)}
            >
              Copy token
            </button>
            {copyLine("token")}
          </div>
          <p className="muted">Shown this once. Copy it now: Warden keeps only its hash.</p>
        </div>
      )}
      <div className="hook-actions">
        <button
          ref={rotateButton}
          type="button"
          className={settings.token === null ? "primary" : "secondary"}
          disabled={issuing || confirming}
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
      {confirming && previousUntil !== null && (
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
          disabled={pendingTier !== null}
          aria-busy={pendingTier !== null}
          onChange={(event) => void changeTier(PrivacyTier.parse(event.target.value))}
        >
          {PrivacyTier.options.map((tier) => (
            <option key={tier} value={tier}>
              {TIER_WORDS[tier]}
            </option>
          ))}
        </select>
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
        {copyLine("block")}
      </div>
    </div>
  );
}
