import { SignIn, useAuth, useUser } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { fetchMe, type MeResult } from "./me.ts";

export function App() {
  const { isLoaded, isSignedIn, sessionId, signOut } = useAuth();
  // The session the server turned down. Kept after Clerk signs the person out, so the sign-in page says why;
  // a new sign-in has a new session id, so it no longer matches.
  const [endedSession, setEndedSession] = useState<string | null>(null);

  const onSessionEnded = useCallback(() => {
    setEndedSession(sessionId ?? "");
    void signOut();
  }, [sessionId, signOut]);

  if (!isLoaded) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!isSignedIn || sessionId === endedSession) {
    return <SignInPage sessionEnded={endedSession !== null} />;
  }
  return <SignedInPage onSessionEnded={onSessionEnded} onSignOut={() => void signOut()} />;
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
        {me !== "checking" && me.kind === "not-answering" && (
          <p className="notice" role="alert">
            Warden's server isn't answering
          </p>
        )}
        <div className="actions">
          <button type="button" className="primary" onClick={props.onSignOut}>
            Sign out
          </button>
          {me !== "checking" && me.kind === "not-answering" && (
            <button type="button" className="secondary" onClick={retry}>
              Retry
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
