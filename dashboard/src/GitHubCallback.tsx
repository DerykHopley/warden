// `/setup/github/callback`: GitHub's callback URL (Guard spec, story 1). GitHub sends the Admin back here with a
// `code` and the `state` the sign-in left with; the attempt kept in this tab must have that state, and its verifier
// goes to Warden with the code. GitHub's code works once, so the attempt is removed before the one link call, and the
// code leaves the address bar as it's read.
import { useEffect, useState } from "react";
import type { PageProps } from "./App.tsx";
import {
  linkInstallation,
  putBackAttempt,
  takeAttempt,
  tooManyTries,
  type LinkResult,
} from "./github-setup.ts";

const CALLBACK_PATH = "/setup/github/callback";

type Outcome =
  | LinkResult
  /** No kept attempt, no code or state, or a state that isn't the attempt's: nothing is sent. */
  | { kind: "not-started-here" }
  /** GitHub's `error=access_denied`: the person cancelled on GitHub. */
  | { kind: "cancelled" }
  /** Any other GitHub `error`: its code when it reads as one (`redirect_uri_mismatch`), so an operator sees the cause. */
  | { kind: "github-refused"; error: string | null };

/** An OAuth error code as GitHub sends one; anything else in `error` isn't shown, as it could be anyone's words. */
const ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * Reads GitHub's answer and the kept attempt, and links the installation when they match. The query is read and taken
 * out of the address bar before anything waits. When the session has ended, the code never reached Warden: the attempt
 * and the query are put back, so the page links once the person signs in again.
 */
async function finishSignIn(props: PageProps): Promise<Outcome> {
  const search = location.search;
  const query = new URLSearchParams(search);
  history.replaceState(null, "", CALLBACK_PATH);
  const attempt = takeAttempt();
  const error = query.get("error");
  if (error === "access_denied") return { kind: "cancelled" };
  if (error !== null) {
    return { kind: "github-refused", error: ERROR_CODE.test(error) ? error : null };
  }
  const code = query.get("code");
  if (
    attempt === undefined ||
    code === null ||
    code === "" ||
    query.get("state") !== attempt.state
  ) {
    return { kind: "not-started-here" };
  }
  const answer = await linkInstallation(props.getToken, {
    installation_id: attempt.installationId,
    code,
    code_verifier: attempt.verifier,
  });
  if (answer.kind === "session-ended") {
    putBackAttempt(attempt);
    history.replaceState(null, "", `${CALLBACK_PATH}${search}`);
  }
  return answer;
}

/**
 * This page load's one sign-in, shared by every mount of the page: React running the effect twice (StrictMode), or
 * the page mounted again while the call runs, waits on the same call. An address with a query is a new visit.
 */
let visit: Promise<Outcome> | undefined;

function currentVisit(props: PageProps): Promise<Outcome> {
  if (visit === undefined || location.search !== "") visit = finishSignIn(props);
  return visit;
}

export function GitHubCallbackPage(props: PageProps) {
  const [outcome, setOutcome] = useState<Outcome | "linking">("linking");
  const { onSessionEnded } = props;

  useEffect(() => {
    let live = true;
    void currentVisit(props).then((answer) => {
      if (!live) return;
      setOutcome(answer);
      if (answer.kind === "session-ended") onSessionEnded();
    });
    return () => {
      live = false;
    };
    // Once per mount: GitHub's code can't be sent twice, so later changes to the props don't ask again.
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
    case "github-refused":
      return (
        <Alert
          words={`GitHub refused the sign-in${outcome.error === null ? "" : ` (${outcome.error})`}; nothing was linked.`}
        />
      );
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
