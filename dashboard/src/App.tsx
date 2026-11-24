import { ClerkFailed, OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/react";
import type { Level, Role } from "@warden/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
import { askAboutTeam, type GetToken } from "./api.ts";
import { AskWardenPanel, usePanelState } from "./AskWardenPanel.tsx";
import { FindingsPage } from "./Findings.tsx";
import { landingPage } from "./landing.ts";
import { fetchMe, type MeResult } from "./me.ts";
import { OverviewPage } from "./Overview.tsx";
import type { PagePanel, PanelContext } from "./panel.ts";
import { PeoplePage } from "./People.tsx";
import { ROLE_WORDS } from "./roles.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

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

  if (!isLoaded) return <WaitingForClerk />;
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

/** How long Clerk may take to load before the page says sign-in couldn't load. */
const CLERK_LOAD_LIMIT_MS = 10_000;

/**
 * "Loading…" while Clerk loads; the notice in its place once Clerk reports that it failed to load (`<ClerkFailed>`,
 * when its status is `error`), or after 10 seconds without it loading (an ad blocker or a lost connection can stop its
 * script, and then nothing is reported).
 */
function WaitingForClerk() {
  const [failed, setFailed] = useState(false);
  const onFailed = useCallback(() => setFailed(true), []);
  useEffect(() => {
    const timer = setTimeout(onFailed, CLERK_LOAD_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [onFailed]);
  return (
    <>
      <ClerkFailed>
        <CallOnMount onMount={onFailed} />
      </ClerkFailed>
      {failed ? <ClerkLoadFailed /> : <Notice text="Loading…" />}
    </>
  );
}

/** Renders nothing; calls `onMount` once it mounts, so a parent learns that a wrapper rendered its children. */
function CallOnMount({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return null;
}

function ClerkLoadFailed() {
  return (
    <main className="page">
      <p className="notice" role="alert">
        Sign-in couldn't load. An ad blocker or a lost connection can stop it.
      </p>
      <button type="button" className="primary" onClick={() => location.reload()}>
        Try again
      </button>
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
  /**
   * The person signed in, their Team (the active one) and Role in it, and the Team's Level, as /api/me last answered
   * them.
   */
  me: { userId: string; team: string | null; role: Role | null; level: Level | null };
  onSessionEnded: () => void;
  /** Ask /api/me again, after a change that may have moved the person's own Role. */
  refreshMe: () => void;
  /** The Ask Warden panel: what the page is talking about, and opening it. Without a context it names the page. */
  panel: PagePanel;
};

const noFocusToClear = () => {};

/**
 * Warden's pages, in the header's order. The main area shows the one whose path is the address bar's; `/` shows the
 * person's landing page (`landingPage`). Each later slice adds its page here.
 */
const PAGES: { path: string; label: string; Page: ComponentType<PageProps> }[] = [
  { path: "/findings", label: "Findings", Page: FindingsPage },
  { path: "/overview", label: "Overview", Page: OverviewPage },
  { path: "/people", label: "People", Page: PeoplePage },
];

/** The address bar's path without a trailing slash; `/` stays `/`. */
const currentPath = () => location.pathname.replace(/\/+$/, "") || "/";

const pageAt = (path: string) => PAGES.find((page) => page.path === path);

// "Personal account" is never a choice: Warden works only inside a Team.
const switcher = <OrganizationSwitcher hidePersonal />;

function AppShell(props: { onSessionEnded: () => void; onSignOut: () => void }) {
  const { getToken, orgId: activeOrg } = useAuth();
  const orgId = activeOrg ?? null;
  const { organization } = useOrganization();
  const { onSessionEnded } = props;

  // A new active Organization is a new call: the last Team's answer goes at once, and a late one is dropped. An
  // answer about another Team is asked again (askAboutTeam): the Team's name and Role never show beside another's.
  const askMe = useCallback(
    (signal: AbortSignal): Promise<MeResult> =>
      askAboutTeam(
        () => fetchMe(() => getToken()),
        (result) => (result.kind === "signed-in" ? result.team : undefined),
        orgId,
        signal,
      ),
    [getToken, orgId],
  );
  const me = useWardenCall(askMe, onSessionEnded);

  const signedIn = me.result !== "loading" && me.result.kind === "signed-in" ? me.result : null;
  const noTeam = signedIn !== null && signedIn.team === null;
  // At `/`, the person's Role picks the page, once /api/me has answered; until then no page shows.
  const path = currentPath();
  const landing = path === "/" && signedIn?.role ? landingPage(signedIn.role) : null;
  const page = pageAt(landing ?? path);
  useEffect(() => {
    if (landing !== null && currentPath() === "/") history.replaceState(null, "", landing);
  }, [landing]);

  // The panel is on every page; a page tells it what it's talking about. Until it does, the context is the page. A
  // page clears its context as it unmounts, and a new Team clears it at once, so one Team's Finding never shows in
  // another's detail card.
  const panelState = usePanelState();
  const [pageContext, setPageContext] = useState<PanelContext | null>(null);
  const team = signedIn?.team ?? null;
  const [contextTeam, setContextTeam] = useState(team);
  if (contextTeam !== team) {
    setContextTeam(team);
    setPageContext(null);
  }
  const { openFloating } = panelState;

  // The floating panel starts below the header, so the header's controls stay reachable while it floats.
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (header === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeaderHeight(header.offsetHeight));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const frameStyle = (
    headerHeight === null ? undefined : { "--header-height": `${headerHeight}px` }
  ) as CSSProperties | undefined;
  const pagePanel = useMemo<PagePanel>(
    () => ({ setContext: setPageContext, open: openFloating }),
    [openFloating],
  );
  const showsPage = signedIn !== null && !noTeam && page !== undefined;
  const panelContext = pageContext ?? {
    view: page === undefined ? [] : [page.label],
    focus: null,
    clearFocus: noFocusToClear,
  };

  return (
    <div className="app-frame" style={frameStyle}>
      <div className="app-column">
        <header className="app-header" ref={headerRef}>
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
          {me.result !== "loading" && <TeamRefused result={me.result} />}
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
              panel={pagePanel}
            />
          )}
        </main>
      </div>
      {showsPage && (
        <AskWardenPanel
          panel={panelState}
          context={panelContext}
          getToken={getToken}
          team={signedIn?.team ?? null}
          onSessionEnded={onSessionEnded}
        />
      )}
    </div>
  );
}
