// Setup's Judge's model section (spec #225, slice 6b, story 10): an Admin sees which model judges the Team's sessions,
// names the Team's own OpenAI-compatible model (a URL and a model name), or puts the Team back on OpenRouter. The
// server checks the URL against its URL rule and says why it refuses one; the section shows those words as they come.
import { type JudgeModelChange } from "@warden/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NOT_ANSWERING, TEAM_NOT_OPENED, tryAgainIn } from "./api.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { type ChangeRefused } from "./hook.ts";
import { fetchJudgeModel, setJudgeModel, type JudgeModelResult } from "./judge-model.ts";
import { useReportAnswered, type SectionProps } from "./setup-section.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

const ADMIN_SETS = "An Admin sets the Judge's model.";
const ONLY_ADMIN = "Only an Admin sets the Judge's model.";

/** A refused change in words, or null for a session that ended (the shell signs out), as the agent hook's are. */
function refusalWords(result: ChangeRefused): string | null {
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

type JudgeModelSectionProps = SectionProps & {
  /** Setup's one ask for the Role, which the other sections' 403s share as the page opens. */
  roleChanged: () => void;
};

/**
 * An Admin's Judge's model; a Lead or a Member reads who sets it, and the route is never called. Only an Admin's Setup
 * waits for the setting to answer.
 */
export function JudgeModelSection(props: JudgeModelSectionProps) {
  return props.me.role === "admin" ? (
    <JudgeModelSetting {...props} />
  ) : (
    <p className="muted">{ADMIN_SETS}</p>
  );
}

/** Which change is under way: a save, or the clear that puts the Team back on OpenRouter. */
type Changing = "save" | "clear";

function JudgeModelSetting({
  getToken,
  me,
  onSessionEnded,
  refreshMe,
  roleChanged,
  onAnswered,
}: JudgeModelSectionProps) {
  const ask = useCallback(() => fetchJudgeModel(getToken), [getToken]);
  const call = useWardenCall<JudgeModelResult>(ask, onSessionEnded);
  const { setResult } = call;
  useReportAnswered(call.result !== "loading", "judge-model", onAnswered);
  // A 403 as the page opens: the Role changed since /api/me answered, so Setup asks again, once the page has rendered.
  // A 403 on a later change asks the shell itself (`refused`), as the agent hook's changes do.
  const notAdmin = call.result !== "loading" && call.result.kind === "not-admin";
  useEffect(() => {
    if (notAdmin) roleChanged();
  }, [notAdmin, roleChanged]);

  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [changing, setChanging] = useState<Changing | null>(null);
  // Set at the click (or the Enter) itself, before React renders the disabled buttons: one PUT per change.
  const changeCall = useRef(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function change(what: Changing, localModel: JudgeModelChange["local_model"]) {
    if (changeCall.current) return;
    changeCall.current = true;
    setChanging(what);
    setRefusal(null);
    const result = await setJudgeModel(getToken, me.team, localModel);
    changeCall.current = false;
    setChanging(null);
    if (result.kind === "set") {
      const body = result.body;
      setResult(() => ({ kind: "model", body }));
      return;
    }
    if (result.kind === "forbidden") refreshMe();
    const words = refusalWords(result);
    if (words === null) return onSessionEnded();
    setRefusal(words);
  }

  function onSave(event: FormEvent) {
    event.preventDefault();
    // Sent as typed: the server's URL rule and model-name check say what's wrong, in their own words.
    void change("save", { url, model });
  }

  if (call.result === "loading") {
    return <p className="muted">Asking Warden's server about the Judge's model…</p>;
  }
  if (call.result.kind === "not-admin") return <p className="muted">{ADMIN_SETS}</p>;
  if (call.result.kind !== "model") {
    return (
      <>
        <CallRefused result={call.result} onRetry={call.retry} />
        <TeamRefused result={call.result} />
      </>
    );
  }
  const own = call.result.body.local_model;

  return (
    <div className="judge-model">
      {own === null ? (
        <p>The Judge calls OpenRouter (the default).</p>
      ) : (
        <>
          <p>The Judge calls the Team's own model:</p>
          <dl className="judge-model-setting">
            <dt>URL</dt>
            <dd>
              <code className="judge-model-value">{own.url}</code>
            </dd>
            <dt>Model name</dt>
            <dd>
              <code className="judge-model-value">{own.model}</code>
            </dd>
          </dl>
          <p className="muted">Set {dayAndTimeWords(own.set_at)}</p>
          <div className="hook-actions">
            <button
              type="button"
              className="secondary"
              disabled={changing !== null}
              aria-busy={changing === "clear"}
              onClick={() => void change("clear", null)}
            >
              Use OpenRouter
            </button>
          </div>
        </>
      )}
      <form className="judge-model-form" aria-label="Judge's model" onSubmit={onSave}>
        <label className="field">
          <span className="field-label">URL</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://models.example.com/v1"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Model name</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <p className="muted">
          An OpenAI-compatible base URL over https, whose host is on the public internet.
        </p>
        <div className="form-actions">
          <button
            type="submit"
            className="primary"
            disabled={changing !== null}
            aria-busy={changing === "save"}
          >
            Save
          </button>
        </div>
        {refusal !== null && (
          <p className="notice" role="alert">
            {refusal}
          </p>
        )}
      </form>
    </div>
  );
}
