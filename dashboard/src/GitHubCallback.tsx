// `/setup/github/callback`: GitHub's callback URL (Guard spec, story 1). GitHub sends the Admin back here with a
// `code` and the `state` the sign-in left with; the attempt kept in this tab must have that state, and its verifier
// goes to Warden with the code. GitHub's code works once, so the attempt is removed before the one link call.
import { useEffect, useRef, useState } from "react";
import type { PageProps } from "./App.tsx";
import { linkInstallation, takeAttempt, tooManyTries, type LinkResult } from "./github-setup.ts";

type Outcome =
  | LinkResult
  /** No kept attempt, no code or state, or a state that isn't the attempt's: nothing is sent. */
  | { kind: "not-started-here" }
  /** GitHub's `error=access_denied`: the person cancelled on GitHub. */
  | { kind: "cancelled" };

/** Reads GitHub's answer and the kept attempt, and links the installation when they match. */
async function finishSignIn(props: PageProps): Promise<Outcome> {
  const query = new URLSearchParams(location.search);
  const attempt = takeAttempt();
  if (query.get("error") === "access_denied") return { kind: "cancelled" };
  const code = query.get("code");
  if (
    attempt === undefined ||
    code === null ||
    code === "" ||
    query.get("state") !== attempt.state
  ) {
    return { kind: "not-started-here" };
  }
  return linkInstallation(props.getToken, {
    installation_id: attempt.installationId,
    code,
    code_verifier: attempt.verifier,
  });
}

export function GitHubCallbackPage(props: PageProps) {
  const [outcome, setOutcome] = useState<Outcome | "linking">("linking");
  // The one call, kept across React running this effect twice (StrictMode): a second run waits on the same call.
  const started = useRef<Promise<Outcome> | null>(null);
  const { onSessionEnded } = props;

  useEffect(() => {
    started.current ??= finishSignIn(props);
    let live = true;
    void started.current.then((answer) => {
      if (!live) return;
      setOutcome(answer);
      if (answer.kind === "session-ended") onSessionEnded();
    });
    return () => {
      live = false;
    };
    // Once per visit: GitHub's code can't be sent twice, so later changes to the props don't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h1>Connect GitHub</h1>
      <Said outcome={outcome} />
      {outcome !== "linking" && outcome.kind !== "session-ended" && (
        <p className="setup-link">
          <a href="/setup">Back to Setup</a>
        </p>
      )}
    </>
  );
}

function Said({ outcome }: { outcome: Outcome | "linking" }) {
  if (outcome === "linking") return <p className="muted">Linking the installation…</p>;
  switch (outcome.kind) {
    case "linked":
      return (
        <p>
          Linked installation {outcome.installationId}: {outcome.repoCount}{" "}
          {outcome.repoCount === 1 ? "repo" : "repos"}.
        </p>
      );
    case "refused":
      return <Alert words={outcome.words} />;
    case "too-many-attempts":
      return <Alert words={tooManyTries(outcome.retryAfter)} />;
    // No Retry: GitHub's code is spent, so a retry can't link, and the link may already have been made.
    case "not-answering":
      return <Alert words="Warden didn't answer; the link may not have been made." />;
    case "not-started-here":
      return <Alert words="This GitHub sign-in didn't start here. Connect again from Setup." />;
    case "cancelled":
      return <p>You cancelled the GitHub sign-in; nothing was linked.</p>;
    case "session-ended":
      return null;
  }
}

function Alert({ words }: { words: string }) {
  return (
    <p className="notice" role="alert">
      {words}
    </p>
  );
}
