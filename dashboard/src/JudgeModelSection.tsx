// Setup's Judge's model section (spec #225, slice 6b, story 10): an Admin sees which model judges the Team's sessions,
// names the Team's own OpenAI-compatible model (a URL and a model name), or puts the Team back on OpenRouter. The
// server checks the URL against its URL rule and says why it refuses one; the section shows those words as they come.
import { type JudgeModelChange } from "@warden/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { refusalWords } from "./change-refused.ts";
import { dayAndTimeWords } from "./date-words.ts";
import { fetchJudgeModel, setJudgeModel, type JudgeModelResult } from "./judge-model.ts";
import { useReportAnswered, type SectionProps } from "./setup-section.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

const ADMIN_SETS = "An Admin sets the Judge's model.";
const ONLY_ADMIN = "Only an Admin sets the Judge's model.";

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
    if (result.kind !== "set" && result.kind !== "session-ended") {
      // Another Admin may have changed it since it was read, or this PUT may have landed with its answer lost: read it
      // again, busy still, so the shown setting is the server's, as the agent hook's rotation does.
      const reread = await fetchJudgeModel(getToken);
      if (reread.kind === "model") setResult(() => reread);
    }
    changeCall.current = false;
    setChanging(null);
    if (result.kind === "set") {
      const body = result.body;
      setResult(() => ({ kind: "model", body }));
      return;
    }
    if (result.kind === "forbidden") refreshMe();
    const words = refusalWords(result, ONLY_ADMIN);
    if (words === null) return onSessionEnded();
    setRefusal(words);
  }

  function onSave(event: FormEvent) {
    event.preventDefault();
    // Trimmed, as a paste can leave a space that the server would keep and every Judge call would then fail on; the
    // server's URL rule and model-name check say what else is wrong, in their own words.
    void change("save", { url: url.trim(), model: model.trim() });
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
          <div className="judge-model-actions">
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
      {/* Named apart from its section, so a screen reader's landmarks tell the two apart. */}
      <form className="judge-model-form" aria-label="The Team's own model" onSubmit={onSave}>
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
