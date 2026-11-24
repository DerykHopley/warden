import { SignIn, useAuth, useUser } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { fetchMe, type MeResult } from "./me.ts";

export function App() {
  const { isLoaded, isSignedIn, sessionId, signOut } = useAuth();
  // The session the server turned down. Kept after Clerk signs the person out, so the sign-in page says why,
  // and forgotten once a different session signs in.
  const [endedSession, setEndedSession] = useState<string | null>(null);
  if (isSignedIn && sessionId && endedSession !== null && sessionId !== endedSession) {
    setEndedSession(null);
  }

  const onSessionEnded = useCallback(() => {
    setEndedSession(sessionId ?? "");
    signOut().catch(() => {});
  }, [sessionId, signOut]);

  if (!isLoaded) return <Notice text="Loading…" />;
  // Clerk's sign-in doesn't mount while Clerk still holds the session it is ending.
  if (isSignedIn && sessionId === endedSession) return <Notice text="Signing you out…" />;
  if (!isSignedIn) return <SignInPage sessionEnded={endedSession !== null} />;
  return <SignedInPage onSessionEnded={onSessionEnded} onSignOut={() => void signOut()} />;
}

function Notice({ text }: { text: string }) {
  return (
    <main className="page">
      <p className="muted">{text}</p>
    </main>
  );
}

function SignInPage({ sessionEnded }: { sessionEnded: boolean }) {
  return (
    <main className="page">
      <h1>Warden</h1>
      {sessionEnded && <p className="notice">Your session has ended: sign in again</p>}
      <SignIn />
    </main>
  );
}

function SignedInPage(props: { onSessionEnded: () => void; onSignOut: () => void }) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const [me, setMe] = useState<MeResult | "checking">("checking");
  const [attempt, setAttempt] = useState(0);
  const { onSessionEnded } = props;

  useEffect(() => {
    let current = true;
    void fetchMe(() => getToken()).then((result) => {
      if (!current) return;
      setMe(result);
      if (result.kind === "session-ended") onSessionEnded();
    });
    return () => {
      current = false;
    };
  }, [getToken, onSessionEnded, attempt]);

  const notAnswering = me !== "checking" && me.kind === "not-answering";
  const retry = () => {
    setMe("checking");
    setAttempt((n) => n + 1);
  };

  return (
    <main className="page">
      <div className="card">
        <h1>Warden</h1>
        <p>Signed in as {user?.primaryEmailAddress?.emailAddress ?? "…"}</p>
        {me === "checking" && <p className="muted">Checking your session with Warden's server…</p>}
        {me !== "checking" && me.kind === "signed-in" && (
          <p>
            Your user id, as Warden's server read it: <code>{me.userId}</code>
          </p>
        )}
        {notAnswering && (
          <p className="notice" role="alert">
            Warden's server isn't answering
          </p>
        )}
        {me !== "checking" && me.kind === "team-not-opened" && (
          <p className="notice" role="alert">
            Your Team's Admin must open Warden first. Try again once they have.
          </p>
        )}
        {me !== "checking" && me.kind === "too-many-attempts" && (
          <p className="notice" role="alert">
            Too many sign-in attempts. Try again in{" "}
            {me.retryAfter === null ? "a minute" : `${me.retryAfter} seconds`}.
          </p>
        )}
        <div className="actions">
          {notAnswering && (
            <button type="button" className="primary" onClick={retry}>
              Retry
            </button>
          )}
          {/* One main action per screen: while the server isn't answering, that's Retry. */}
          <button
            type="button"
            className={notAnswering ? "secondary" : "primary"}
            onClick={props.onSignOut}
          >
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
