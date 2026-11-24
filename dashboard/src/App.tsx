import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { tryAgainIn } from "./api.ts";
import { fetchMe, type MeResult } from "./me.ts";
import { PeoplePage, ROLE_WORDS, type PeopleProps } from "./People.tsx";

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
  return <AppShell onSessionEnded={onSessionEnded} onSignOut={() => void signOut()} />;
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

/**
 * Warden's pages, in the header's order. The main area shows the one whose path is the address bar's; the first
 * also shows at `/`. Each later slice adds its page here.
 */
const PAGES: { path: string; label: string; Page: ComponentType<PeopleProps> }[] = [
  { path: "/people", label: "People", Page: PeoplePage },
];

function pageAt(pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" ? PAGES[0] : PAGES.find((page) => page.path === path);
}

// "Personal account" is never a choice: Warden works only inside a Team.
const switcher = <OrganizationSwitcher hidePersonal />;

function AppShell(props: { onSessionEnded: () => void; onSignOut: () => void }) {
  const { getToken, orgId: activeOrg } = useAuth();
  const orgId = activeOrg ?? null;
  const { organization } = useOrganization();
  const [me, setMe] = useState<MeResult | "checking">("checking");
  const [attempt, setAttempt] = useState(0);
  const { onSessionEnded } = props;

  // A switch to another Organization forgets the last Team's answer at once, before the new one is asked for.
  const [askedFor, setAskedFor] = useState(orgId);
  if (askedFor !== orgId) {
    setAskedFor(orgId);
    setMe("checking");
  }

  useEffect(() => {
    // An answer that arrives after a switch (or a newer ask) is dropped: it was about another Team.
    let current = true;
    void fetchMe(() => getToken()).then((result) => {
      if (!current) return;
      setMe(result);
      if (result.kind === "session-ended") onSessionEnded();
    });
    return () => {
      current = false;
    };
  }, [getToken, orgId, onSessionEnded, attempt]);

  const refreshMe = useCallback(() => setAttempt((n) => n + 1), []);
  const retry = () => {
    setMe("checking");
    refreshMe();
  };

  // The Team's name and the Role show only when the server's answer is about the active Organization.
  const answer =
    me !== "checking" && me.kind === "signed-in" && me.team !== orgId ? "checking" : me;
  const signedIn = answer !== "checking" && answer.kind === "signed-in" ? answer : null;
  const noTeam = signedIn !== null && signedIn.team === null;
  const page = pageAt(location.pathname);

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">Warden</span>
          {(answer === "checking" || (signedIn && !noTeam)) && (
            <span className="team">
              <span className="team-name">
                {signedIn && organization?.id === signedIn.team ? organization.name : "…"}
              </span>
              <span className="role">{signedIn?.role ? ROLE_WORDS[signedIn.role] : "…"}</span>
            </span>
          )}
          {!noTeam && (
            <>
              <nav className="page-links" aria-label="Pages">
                {PAGES.map(({ path, label }) => (
                  <a key={path} href={path} aria-current={page?.path === path ? "page" : undefined}>
                    {label}
                  </a>
                ))}
              </nav>
              <div className="switcher">{switcher}</div>
            </>
          )}
          <button type="button" className="secondary sign-out" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="page">
        {answer === "checking" && (
          <p className="muted">Checking your session with Warden's server…</p>
        )}
        {answer !== "checking" && answer.kind === "not-answering" && (
          <>
            <p className="notice" role="alert">
              Warden's server isn't answering
            </p>
            <button type="button" className="primary" onClick={retry}>
              Retry
            </button>
          </>
        )}
        {answer !== "checking" && answer.kind === "team-not-opened" && (
          <p className="notice" role="alert">
            Your Team's Admin must open Warden first. Try again once they have.
          </p>
        )}
        {answer !== "checking" && answer.kind === "too-many-attempts" && (
          <p className="notice" role="alert">
            {tryAgainIn(answer.retryAfter)}
          </p>
        )}
        {noTeam && (
          <div className="card">
            <p>Create a Team, or choose one you've been invited to</p>
            {switcher}
          </div>
        )}
        {signedIn !== null && !noTeam && page === undefined && (
          <p className="muted">There's no page here. Choose one above.</p>
        )}
        {signedIn !== null && !noTeam && page !== undefined && (
          <page.Page
            getToken={getToken}
            me={signedIn}
            onSessionEnded={onSessionEnded}
            refreshMe={refreshMe}
          />
        )}
      </main>
    </>
  );
}
