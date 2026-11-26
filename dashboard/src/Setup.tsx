// The Setup page (Guard spec, stories 1 and 2): an Admin connects GitHub from here, anyone in the Team sees its Repo
// Assets with each one's last Scan, and a Lead or an Admin starts a Scan of them. GitHub sends the Admin back from installing the app to `/setup/github`, its Setup URL, which asks them to
// sign in with GitHub so Warden can link that installation to the Team.
import { useOrganization } from "@clerk/react";
import { MAX_SCAN_ASSETS, type ListedRepoBody, type ScanBody } from "@warden/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { NOT_ANSWERING, TEAM_NOT_OPENED } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { dayAndTimeWords } from "./date-words.ts";
import {
  fetchGitHubApp,
  fetchRepos,
  installationIdFrom,
  installUrl,
  scanRepos,
  startSignIn,
  tooManyTries,
  type GitHubAppResult,
  type ReposResult,
} from "./github-setup.ts";
import { goTo } from "./navigate.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** How long after each answer the repo list is read again while a listed Scan is queued or running. */
const READ_AGAIN_MS = 5_000;
const NOT_A_LEAD = "Only a Lead or an Admin starts a Scan.";
const ADMIN_CONNECTS = "An Admin connects GitHub.";
const NOT_SET_UP = "GitHub isn't set up on this Warden.";
const CANT_START =
  "This browser couldn't start the GitHub sign-in. Allow this site to store data for this tab, and open Warden over https.";

export function SetupPage(props: PageProps) {
  return (
    <>
      <h1>Setup</h1>
      <section className="setup-section" aria-labelledby="setup-github">
        <h2 id="setup-github">GitHub</h2>
        {props.me.role === "admin" ? (
          <InstallLink {...props} />
        ) : (
          <p className="muted">{ADMIN_CONNECTS}</p>
        )}
      </section>
      <section className="setup-section" aria-labelledby="setup-repos">
        <h2 id="setup-repos">Repos</h2>
        <RepoList {...props} />
      </section>
    </>
  );
}

/** The App's settings, asked for only by an Admin: a Lead or a Member never calls `/api/github/app`. */
function useGitHubApp({ getToken, onSessionEnded, refreshMe }: PageProps) {
  const ask = useCallback(() => fetchGitHubApp(getToken), [getToken]);
  const app = useWardenCall<GitHubAppResult>(ask, onSessionEnded);
  // A 403: the person's Role changed since /api/me answered, so the shell asks again, once the page has rendered.
  const notAdmin = app.result !== "loading" && app.result.kind === "not-admin";
  useEffect(() => {
    if (notAdmin) refreshMe();
  }, [notAdmin, refreshMe]);
  return app;
}

/** What the App's answer shows in place of the install link or the sign-in button: waiting, and each refusal. */
function AppNotReady({ app }: { app: ReturnType<typeof useGitHubApp> }) {
  if (app.result === "loading")
    return <p className="muted">Asking Warden's server about GitHub…</p>;
  if (app.result.kind === "not-set-up") return <p className="muted">{NOT_SET_UP}</p>;
  if (app.result.kind === "not-admin") return <p className="muted">{ADMIN_CONNECTS}</p>;
  return (
    <>
      <CallRefused result={app.result} onRetry={app.retry} />
      <TeamRefused result={app.result} />
    </>
  );
}

function InstallLink(props: PageProps) {
  const app = useGitHubApp(props);
  if (app.result !== "loading" && app.result.kind === "app") {
    return (
      <p className="setup-link">
        <a href={installUrl(app.result.app.slug)}>Install the GitHub app</a>
      </p>
    );
  }
  return <AppNotReady app={app} />;
}

/** A repo's last Scan, in the row beside its ref (story 2). */
function lastScanWords(scan: ScanBody | null): string {
  if (scan === null) return "Never scanned";
  switch (scan.state) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    // A done or failed Scan always has an ended_at; its queued_at only stands in for the type.
    case "done":
      return `Done, ${dayAndTimeWords(scan.ended_at ?? scan.queued_at)}`;
    case "failed":
      return `Failed, ${dayAndTimeWords(scan.ended_at ?? scan.queued_at)}`;
  }
}

const isUnderWay = (repo: ListedRepoBody) =>
  repo.last_scan?.state === "queued" || repo.last_scan?.state === "running";

function RepoList({ getToken, me, onSessionEnded, refreshMe }: PageProps) {
  const ask = useCallback(() => fetchRepos(getToken), [getToken]);
  const list = useWardenCall<ReposResult>(ask, onSessionEnded);
  const { refresh } = list;
  const [starting, setStarting] = useState(false);
  // Set at the click itself, before React renders the disabled button: one start per click.
  const startRuns = useRef(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const listed = list.result !== "loading" && list.result.kind === "repos" ? list.result : null;
  const underWay = listed?.repos.some(isUnderWay) ?? false;

  // While a listed Scan is queued or running, the list is read again READ_AGAIN_MS after each answer, keeping it on
  // screen; an answer with none under way, an unreadable list, or leaving the page stops it.
  useEffect(() => {
    if (!underWay) return;
    const next = setTimeout(refresh, READ_AGAIN_MS);
    return () => clearTimeout(next);
  }, [underWay, listed, refresh]);

  async function scanNow(repos: ListedRepoBody[]) {
    if (startRuns.current) return;
    startRuns.current = true;
    setStarting(true);
    setRefusal(null);
    const result = await scanRepos(
      getToken,
      repos.slice(0, MAX_SCAN_ASSETS).map((repo) => repo.asset),
    );
    startRuns.current = false;
    setStarting(false);
    switch (result.kind) {
      case "started":
        return refresh();
      case "refused":
        setRefusal(result.words);
        if (result.listChanged) refresh();
        return;
      case "forbidden":
        setRefusal(NOT_A_LEAD);
        return refreshMe();
      case "team-not-opened":
        return setRefusal(TEAM_NOT_OPENED);
      case "too-many-attempts":
        return setRefusal(tooManyTries(result.retryAfter));
      case "not-answering":
        return setRefusal(NOT_ANSWERING);
      case "session-ended":
        return onSessionEnded();
    }
  }

  if (list.result === "loading") return <p className="muted">Loading the Team's repos…</p>;
  if (listed === null) {
    return (
      <>
        <CallRefused result={list.result} onRetry={list.retry} />
        <TeamRefused result={list.result} />
      </>
    );
  }
  if (listed.repos.length === 0) return <p className="muted">No repos linked yet.</p>;
  return (
    <>
      {(me.role === "lead" || me.role === "admin") && (
        <div className="scan-now">
          <button
            type="button"
            className="primary"
            disabled={starting || underWay}
            aria-busy={starting}
            onClick={() => void scanNow(listed.repos)}
          >
            Scan now
          </button>
          {underWay && <span className="muted">A Scan is under way.</span>}
        </div>
      )}
      {refusal !== null && (
        <p className="notice" role="alert">
          {refusal}
        </p>
      )}
      <ul className="repo-list">
        {listed.repos.map((repo) => (
          <li key={repo.asset.ref}>
            <span className="repo-ref">{repo.asset.ref}</span>
            <span className="repo-scan muted">{lastScanWords(repo.last_scan)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** `/setup/github`: GitHub's Setup URL, which names the installation just made in `installation_id`. */
export function GitHubSetupPage(props: PageProps) {
  return (
    <>
      <h1>Connect GitHub</h1>
      {props.me.role === "admin" ? (
        <LinkInstallation {...props} />
      ) : (
        <p className="muted">Only an Admin links GitHub to the Team.</p>
      )}
    </>
  );
}

function LinkInstallation(props: PageProps) {
  const { organization } = useOrganization();
  const app = useGitHubApp(props);
  const [installationId] = useState(() =>
    installationIdFrom(new URLSearchParams(location.search).get("installation_id")),
  );
  const [leaving, setLeaving] = useState(false);
  const [cantStart, setCantStart] = useState(false);
  const teamName = organization?.id === props.me.team ? organization.name : "your Team";
  const ready = app.result !== "loading" && app.result.kind === "app" ? app.result.app : null;

  // Keeping the attempt needs this tab's `sessionStorage`, and its challenge needs `crypto.subtle`, which a browser
  // gives only over https (or on localhost): without either, the button comes back with a line saying why.
  async function signIn(clientId: string, id: number) {
    setLeaving(true);
    setCantStart(false);
    let url: string;
    try {
      url = await startSignIn(clientId, id);
    } catch {
      setLeaving(false);
      setCantStart(true);
      return;
    }
    goTo(url);
  }

  if (installationId === undefined) {
    return (
      <>
        <p className="notice" role="alert">
          GitHub didn't say which installation. Install the app again.
        </p>
        {ready !== null ? (
          <p className="setup-link">
            <a href={installUrl(ready.slug)}>Install the GitHub app</a>
          </p>
        ) : (
          <AppNotReady app={app} />
        )}
      </>
    );
  }
  return (
    <>
      <p>
        Link installation {installationId} to {teamName}
      </p>
      {cantStart && (
        <p className="notice" role="alert">
          {CANT_START}
        </p>
      )}
      {ready !== null ? (
        <button
          type="button"
          className="primary"
          disabled={leaving}
          aria-busy={leaving}
          onClick={() => void signIn(ready.client_id, installationId)}
        >
          Sign in with GitHub
        </button>
      ) : (
        <AppNotReady app={app} />
      )}
    </>
  );
}
