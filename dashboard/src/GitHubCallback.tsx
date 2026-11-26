// `/setup/github/callback`: GitHub's callback URL (Guard spec, story 1). GitHub sends the Admin back here with a
// `code` and the `state` the sign-in left with; the attempt kept in this tab must have that state, and its verifier
// goes to Warden with the code. GitHub's code works once, so the attempt is removed before the one call, and the
// code leaves the address bar as it's read. `/setup/github/write/callback` is the write app's (#224, story 5): the
// same steps with its own kept attempt, granting write access instead of linking.
import type { LinkInstallationBody } from "@warden/contracts";
import { useEffect, useState } from "react";
import type { PageProps } from "./App.tsx";
import {
  grantWriteAccess,
  linkInstallation,
  putBackAttempt,
  READ_APP,
  takeAttempt,
  tooManyTries,
  WRITE_APP,
  type GrantResult,
  type LinkResult,
  type WardenApp,
} from "./github-setup.ts";

/** What Warden answers the code a callback sends. */
type CallbackAnswer = LinkResult | GrantResult;

type Outcome =
  | CallbackAnswer
  /** No kept attempt, no code or state, or a state that isn't the attempt's: nothing is sent. */
  | { kind: "not-started-here" }
  /** GitHub's `error=access_denied`: the person cancelled on GitHub. */
  | { kind: "cancelled" }
  /** Any other GitHub `error`: its code when it reads as one (`redirect_uri_mismatch`), so an operator sees the cause. */
  | { kind: "github-refused"; error: string | null };

/** What one app's callback sends, and the words that differ between the two apps. */
type Callback = {
  app: WardenApp;
  waiting: string;
  /** What a refusal says wasn't done: "linked" or "granted". */
  done: string;
  notAnswering: string;
  /** A sign-in that didn't start here: no kept attempt of this app's, no code or state, or another state. */
  notStartedHere: string;
  send: (getToken: PageProps["getToken"], body: LinkInstallationBody) => Promise<CallbackAnswer>;
};

const READ_CALLBACK: Callback = {
  app: READ_APP,
  waiting: "Linking the installation…",
  done: "linked",
  notAnswering: "Warden didn't answer; the link may not have been made.",
  notStartedHere: "This GitHub sign-in didn't start here. Connect again from Setup.",
  send: linkInstallation,
};

const WRITE_CALLBACK: Callback = {
  app: WRITE_APP,
  waiting: "Granting write access…",
  done: "granted",
  notAnswering: "Warden didn't answer; write access may not have been granted.",
  notStartedHere: "This GitHub sign-in didn't start here. Grant write access again from Setup.",
  send: grantWriteAccess,
};

/** An OAuth error code as GitHub sends one; anything else in `error` isn't shown, as it could be anyone's words. */
const ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * Reads GitHub's answer and the app's kept attempt, and sends the code when they match. The query is read and taken
 * out of the address bar before anything waits. When the session has ended, the code never reached Warden: the attempt
 * and the query are put back, so the page sends it once the person signs in again.
 */
async function finishSignIn(props: PageProps, callback: Callback): Promise<Outcome> {
  const { app } = callback;
  const search = location.search;
  const query = new URLSearchParams(search);
  history.replaceState(null, "", app.callbackPath);
  const attempt = takeAttempt(app);
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
  const answer = await callback.send(props.getToken, {
    installation_id: attempt.installationId,
    code,
    code_verifier: attempt.verifier,
  });
  if (answer.kind === "session-ended") {
    putBackAttempt(attempt, app);
    history.replaceState(null, "", `${app.callbackPath}${search}`);
  }
  return answer;
}

/**
 * Each app's one sign-in for this page load, shared by every mount of its page: React running the effect twice
 * (StrictMode), or the page mounted again while the call runs, waits on the same call. An address with a query is a
 * new visit.
 */
const visits = new Map<Callback, Promise<Outcome>>();

function currentVisit(props: PageProps, callback: Callback): Promise<Outcome> {
  let visit = visits.get(callback);
  if (visit === undefined || location.search !== "") {
    visit = finishSignIn(props, callback);
    visits.set(callback, visit);
  }
  return visit;
}

export function GitHubCallbackPage(props: PageProps) {
  return <CallbackPage {...props} callback={READ_CALLBACK} />;
}

export function WriteAppCallbackPage(props: PageProps) {
  return <CallbackPage {...props} callback={WRITE_CALLBACK} />;
}

function CallbackPage(props: PageProps & { callback: Callback }) {
  const { callback, onSessionEnded } = props;
  const [outcome, setOutcome] = useState<Outcome | "waiting">("waiting");

  useEffect(() => {
    let live = true;
    void currentVisit(props, callback).then((answer) => {
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
      <h1>{callback.app.heading}</h1>
      <Said outcome={outcome} callback={callback} />
      {outcome !== "waiting" && outcome.kind !== "session-ended" && (
        <p className="setup-link">
          <a href="/setup">Back to Setup</a>
        </p>
      )}
    </>
  );
}

function Said({ outcome, callback }: { outcome: Outcome | "waiting"; callback: Callback }) {
  if (outcome === "waiting") return <p className="muted">{callback.waiting}</p>;
  switch (outcome.kind) {
    case "linked":
      return (
        <p>
          Linked installation {outcome.installationId}: {outcome.repoCount}{" "}
          {outcome.repoCount === 1 ? "repo" : "repos"}.
        </p>
      );
    case "granted":
      return <p>Write access granted through installation {outcome.installationId}.</p>;
    case "refused":
      return <Alert words={outcome.words} />;
    case "too-many-attempts":
      return <Alert words={tooManyTries(outcome.retryAfter)} />;
    // No Retry: GitHub's code is spent, so a retry can't succeed, and the call may already have been made.
    case "not-answering":
      return <Alert words={callback.notAnswering} />;
    case "not-started-here":
      return <Alert words={callback.notStartedHere} />;
    case "cancelled":
      return <p>You cancelled the GitHub sign-in; nothing was {callback.done}.</p>;
    case "github-refused":
      return (
        <Alert
          words={`GitHub refused the sign-in${outcome.error === null ? "" : ` (${outcome.error})`}; nothing was ${callback.done}.`}
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
