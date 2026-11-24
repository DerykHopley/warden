import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/react";
import type { Role } from "@warden/contracts";
import { useCallback, useState, type ComponentType } from "react";
import { TEAM_NOT_OPENED, type GetToken } from "./api.ts";
import { fetchMe, type MeResult } from "./me.ts";
import { PeoplePage } from "./People.tsx";
import { ROLE_WORDS } from "./roles.ts";
import { CallRefused, useWardenCall } from "./warden-call.tsx";

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

/** What the shell gives each page. */
export type PageProps = {
  getToken: GetToken;
  /** The person signed in, and their Role in this Team as /api/me last answered it. */
  me: { userId: string; role: Role | null };
  onSessionEnded: () => void;
  /** Ask /api/me again, after a change that may have moved the person's own Role. */
  refreshMe: () => void;
};

/**
 * Warden's pages, in the header's order. The main area shows the one whose path is the address bar's; the first
 * also shows at `/`. Each later slice adds its page here.
 */
const PAGES: { path: string; label: string; Page: ComponentType<PageProps> }[] = [
  { path: "/people", label: "People", Page: PeoplePage },
];

function pageAt(pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" ? PAGES[0] : PAGES.find((page) => page.path === path);
}

// "Personal account" is never a choice: Warden works only inside a Team.
const switcher = <OrganizationSwitcher hidePersonal />;

/** How often, and how far apart, /api/me is asked again when it answers about another Team than the active one. */
const TEAM_MISMATCH_RETRIES = 3;
const TEAM_MISMATCH_DELAY_MS = 250;

function AppShell(props: { onSessionEnded: () => void; onSignOut: () => void }) {
  const { getToken, orgId: activeOrg } = useAuth();
  const orgId = activeOrg ?? null;
  const { organization } = useOrganization();
  const { onSessionEnded } = props;

  // A new active Organization is a new call: the last Team's answer goes at once, and a late one is dropped.
  // Clerk can still hand out a token for the Organization just left, so an answer about another Team is asked again
  // a few times, then counts as not answering. The Team's name and Role never show beside another Team's.
  const askMe = useCallback(
    async (signal: AbortSignal): Promise<MeResult> => {
      for (let tries = 1; ; tries++) {
        const result = await fetchMe(() => getToken());
        if (result.kind !== "signed-in" || result.team === orgId) return result;
        if (tries > TEAM_MISMATCH_RETRIES || signal.aborted) return { kind: "not-answering" };
        await new Promise((resolve) => setTimeout(resolve, TEAM_MISMATCH_DELAY_MS));
      }
    },
    [getToken, orgId],
  );
  const me = useWardenCall(askMe, onSessionEnded);

  const signedIn = me.result !== "loading" && me.result.kind === "signed-in" ? me.result : null;
  const noTeam = signedIn !== null && signedIn.team === null;
  const page = pageAt(location.pathname);

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">Warden</span>
          {(me.result === "loading" || (signedIn && !noTeam)) && (
            <span className="team">
              <span className="team-name">
                {signedIn && organization?.id === signedIn.team ? organization.name : "…"}
              </span>
              <span className="role">{signedIn?.role ? ROLE_WORDS[signedIn.role] : "…"}</span>
            </span>
          )}
          <div className="header-end">
            {!noTeam && (
              <>
                <nav className="page-links" aria-label="Pages">
                  {PAGES.map(({ path, label }) => (
                    <a
                      key={path}
                      href={path}
                      aria-current={page?.path === path ? "page" : undefined}
                    >
                      {label}
                    </a>
                  ))}
                </nav>
                <div className="switcher">{switcher}</div>
              </>
            )}
            <button type="button" className="secondary" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        {me.result === "loading" && (
          <p className="muted">Checking your session with Warden's server…</p>
        )}
        {me.result !== "loading" && <CallRefused result={me.result} onRetry={me.retry} />}
        {me.result !== "loading" && me.result.kind === "team-not-opened" && (
          <p className="notice" role="alert">
            {TEAM_NOT_OPENED}
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
            refreshMe={me.refresh}
          />
        )}
      </main>
    </>
  );
}
