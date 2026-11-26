// The Setup page (Guard spec, stories 1 and 2): an Admin connects GitHub from here, anyone in the Team sees its Repo
// Assets with each one's last Scan, and a Lead or an Admin starts a Scan of them. GitHub sends the Admin back from
// installing the app to `/setup/github`, its Setup URL, which asks them to sign in with GitHub so Warden can link that
// installation to the Team. An Admin grants write access the same way, with Warden's second GitHub app, the write app
// (#224, story 5): its Setup URL is `/setup/github/write`, and everyone in the Team sees the grant.
import { useOrganization } from "@clerk/react";
import {
  assetKey,
  MAX_SCAN_ASSETS,
  startsScans,
  type ListedRepoBody,
  type ScanBody,
} from "@warden/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NOT_ANSWERING, TEAM_NOT_OPENED } from "./api.ts";
import type { PageProps } from "./App.tsx";
import { dayAndTimeWords } from "./date-words.ts";
import {
  fetchGitHubApp,
  fetchRepos,
  fetchWriteGrants,
  installationIdFrom,
  installUrl,
  READ_APP,
  REPOS_ANCHOR,
  scanRepos,
  startSignIn,
  tooManyTries,
  WRITE_APP,
  type GitHubAppResult,
  type ReposResult,
  type WardenApp,
  type WriteGrantsResult,
} from "./github-setup.ts";
import { useLandOnAnchor } from "./land-on-anchor.ts";
import { goTo } from "./navigate.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

/** How long after each answer the repo list is read again while a listed Scan is queued or running. */
const READ_AGAIN_MS = 5_000;
/** The Repos heading, when the address's anchor names it. */
const findReposHeading = (anchor: string) =>
  anchor === REPOS_ANCHOR ? document.getElementById(REPOS_ANCHOR) : null;
const NOT_A_LEAD = "Only a Lead or an Admin starts a Scan.";
/** The write app's Setup URL's path, `WriteAppSetupPage`'s route. */
const WRITE_SETUP_PATH = "/setup/github/write";
/** The Connect page's button, which the write app's how-to names too. */
const SIGN_IN = "Sign in with GitHub";
const CANT_START =
  "This browser couldn't start the GitHub sign-in. Allow this site to store data for this tab, and open Warden over https.";

/** One GitHub app's Setup words: its section on Setup and its Connect page (its Setup URL on GitHub). */
type AppWords = {
  app: WardenApp;
  asking: string;
  /** The app's 503: this Warden has no settings for it. */
  notSetUp: string;
  /** For a Lead or a Member on Setup, and for an Admin on the app's 403. */
  adminDoes: string;
  /** The Connect page for a Lead or a Member. */
  onlyAdmin: string;
  install: string;
  noInstallation: string;
  /** The Connect page's line above "Sign in with GitHub". */
  through: (installationId: number, team: string) => string;
};

const READ_WORDS: AppWords = {
  app: READ_APP,
  asking: "Asking Warden's server about GitHub…",
  notSetUp: "GitHub isn't set up on this Warden.",
  adminDoes: "An Admin connects GitHub.",
  onlyAdmin: "Only an Admin links GitHub to the Team.",
  install: "Install the GitHub app",
  noInstallation: "GitHub didn't say which installation. Install the app again.",
  through: (id, team) => `Link installation ${id} to ${team}`,
};

/** The write app (#224, story 5): the second GitHub app, which Fix PRs go through. */
const WRITE_WORDS: AppWords = {
  app: WRITE_APP,
  asking: "Asking Warden's server about the write app…",
  notSetUp: "Fix PRs aren't set up on this Warden.",
  adminDoes: "An Admin grants write access.",
  onlyAdmin: "Only an Admin grants write access to the Team.",
  install: "Install the write app",
  noInstallation: "GitHub didn't say which installation. Install the write app again.",
  through: (id, team) => `Grant write access through installation ${id} to ${team}`,
};

export function SetupPage(props: PageProps) {
  return (
    <>
      <h1>Setup</h1>
      <section className="setup-section" aria-labelledby="setup-github">
        <h2 id="setup-github">GitHub</h2>
        <AppSection {...props} words={READ_WORDS} />
      </section>
      <section className="setup-section" aria-labelledby="setup-write">
        <h2 id="setup-write">Grant write access</h2>
        <AppSection {...props} words={WRITE_WORDS} HowTo={WriteAppHowTo} />
        <WriteGrantList {...props} />
      </section>
      <section className="setup-section" aria-labelledby={REPOS_ANCHOR}>
        <h2 id={REPOS_ANCHOR}>Repos</h2>
        <RepoList {...props} />
      </section>
    </>
  );
}

type AppProps = PageProps & { words: AppWords };

/** An app's how-to for an Admin, under the install link: told whether this Warden has no settings for the app. */
type HowTo = (props: { notSetUp: boolean }) => ReactNode;

/** An app's section on Setup: its words, and its how-to when it has one. */
type AppSectionProps = AppProps & { HowTo?: HowTo };

/** An Admin's install link, and the app's how-to when it has one; a Lead or a Member reads who does this instead. */
function AppSection(props: AppSectionProps) {
  return props.me.role === "admin" ? (
    <InstallLink {...props} />
  ) : (
    <p className="muted">{props.words.adminDoes}</p>
  );
}

/** The app's settings, asked for only by an Admin: a Lead or a Member never calls the app's settings route. */
function useGitHubApp({ getToken, onSessionEnded, refreshMe, words }: AppProps) {
  const { app: wardenApp } = words;
  const ask = useCallback(() => fetchGitHubApp(getToken, wardenApp), [getToken, wardenApp]);
  const app = useWardenCall<GitHubAppResult>(ask, onSessionEnded);
  // A 403: the person's Role changed since /api/me answered, so the shell asks again, once the page has rendered.
  const notAdmin = app.result !== "loading" && app.result.kind === "not-admin";
  useEffect(() => {
    if (notAdmin) refreshMe();
  }, [notAdmin, refreshMe]);
  return app;
}

/** What the app's answer shows in place of the install link or the sign-in button: waiting, and each refusal. */
function AppNotReady({ app, words }: { app: ReturnType<typeof useGitHubApp>; words: AppWords }) {
  if (app.result === "loading") return <p className="muted">{words.asking}</p>;
  if (app.result.kind === "not-set-up") return <p className="muted">{words.notSetUp}</p>;
  if (app.result.kind === "not-admin") return <p className="muted">{words.adminDoes}</p>;
  return (
    <>
      <CallRefused result={app.result} onRetry={app.retry} />
      <TeamRefused result={app.result} />
    </>
  );
}

function InstallLink({ HowTo, ...props }: AppSectionProps) {
  const app = useGitHubApp(props);
  const answered = app.result === "loading" ? null : app.result;
  return (
    <>
      {answered?.kind === "app" ? (
        <p className="setup-link">
          <a href={installUrl(answered.app.slug)}>{props.words.install}</a>
        </p>
      ) : (
        <AppNotReady app={app} words={props.words} />
      )}
      {HowTo !== undefined && <HowTo notSetUp={answered?.kind === "not-set-up"} />}
    </>
  );
}

/**
 * The write app's how-to (#224, story 16): register it on GitHub, give Warden its keys, then install and link it. It
 * starts open on a Warden with no write app, closed otherwise, and stays as the person leaves it until they leave the
 * page. Its URLs are this page's own origin, so a preview's how-to names the preview's.
 */
function WriteAppHowTo({ notSetUp }: { notSetUp: boolean }) {
  // null until the person (or the 503 opening it) toggles it; the browser's own toggle is read back, so find-in-page
  // opening it is kept too.
  const [open, setOpen] = useState<boolean | null>(null);
  const origin = location.origin;
  return (
    <details
      className="how-to"
      open={open ?? notSetUp}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>How to set up the write app</summary>
      <ol>
        <li>
          <h3>Register the app on GitHub</h3>
          <p>
            In GitHub, open Settings, Developer settings, GitHub Apps, New GitHub App. Register it
            as a second app, apart from the read-only one:
          </p>
          <ul>
            <li>
              Homepage URL: <code>{origin}</code>
            </li>
            <li>
              Callback URL: <code>{`${origin}${WRITE_APP.callbackPath}`}</code>
            </li>
            <li>
              Setup URL: <code>{`${origin}${WRITE_SETUP_PATH}`}</code>
            </li>
            <li>
              Leave "Request user authorization (OAuth) during installation" cleared, so GitHub
              sends you to the Setup URL after an install.
            </li>
            <li>Webhook: clear "Active". The write app has no webhooks.</li>
          </ul>
          <p>Repository permissions, these three and nothing else:</p>
          <ul>
            <li>
              <strong>Contents: Read and write</strong>, to make the Fix PR's branch and commit its
              edit.
            </li>
            <li>
              <strong>Pull requests: Read and write</strong>, to open the Fix PR and find one
              already open.
            </li>
            <li>
              <strong>Metadata: Read-only</strong>, which GitHub requires for every app.
            </li>
          </ul>
          <p>
            No account or organization permissions, and no Workflows. A Fix PR only edits{" "}
            <code>.claude/settings.json</code> or a <code>.mcp.json</code> file, never{" "}
            <code>.github/workflows/</code>. Warden refuses to link an installation that holds any
            other permission, or lacks one of these three.
          </p>
          <p>
            Then generate a client secret and a private key (GitHub downloads the key as a{" "}
            <code>.pem</code>).
          </p>
        </li>
        <li>
          <h3>Give Warden the keys</h3>
          <p>
            Warden's server reads <code>GITHUB_WRITE_APP_CLIENT_ID</code>,{" "}
            <code>GITHUB_WRITE_APP_CLIENT_SECRET</code> and{" "}
            <code>GITHUB_WRITE_APP_PRIVATE_KEY</code> (the <code>.pem</code> as downloaded), all
            three or none. Locally they come from the keyring through <code>.envrc</code>. On Cloud
            Run they come from Secret Manager, with the client id as a repository variable. The
            README's "Granting write access" names each one. Then restart the server: it reads them
            when it starts.
          </p>
        </li>
        <li>
          <h3>Install and link it</h3>
          <p>
            Choose "{WRITE_WORDS.install}" above, and install it on the account or organization
            whose repos should get Fix PRs. GitHub sends you to the Grant write access page. Choose
            "{SIGN_IN}" there. Setup then lists the grant under this section.
          </p>
        </li>
      </ol>
    </details>
  );
}

/** The Team's write grants, shown to every Role; who granted each (a Clerk user id) isn't shown. */
function WriteGrantList({ getToken, onSessionEnded }: PageProps) {
  const ask = useCallback(() => fetchWriteGrants(getToken), [getToken]);
  const grants = useWardenCall<WriteGrantsResult>(ask, onSessionEnded);
  if (grants.result === "loading") {
    return <p className="muted">Loading the Team's write access…</p>;
  }
  if (grants.result.kind !== "grants") {
    return (
      <>
        <CallRefused result={grants.result} onRetry={grants.retry} />
        <TeamRefused result={grants.result} />
      </>
    );
  }
  if (grants.result.grants.length === 0) {
    return <p className="muted">No write access granted.</p>;
  }
  return (
    <>
      {grants.result.grants.map((grant) => (
        <p key={grant.installation_id}>
          Write access granted: installation {grant.installation_id},{" "}
          {dayAndTimeWords(grant.granted_at)}
        </p>
      ))}
    </>
  );
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

type Listed = Extract<ReposResult, { kind: "repos" }>;

/** The list with `scan` as the last Scan of each repo it names: what a 202 started, before the list is read again. */
function withScan(list: ReposResult | "loading", scan: ScanBody): ReposResult | "loading" {
  if (list === "loading" || list.kind !== "repos") return list;
  const named = new Set(scan.assets.map(assetKey));
  return {
    ...list,
    repos: list.repos.map((repo) =>
      named.has(assetKey(repo.asset)) ? { ...repo, last_scan: scan } : repo,
    ),
  };
}

function RepoList({ getToken, me, onSessionEnded, refreshMe }: PageProps) {
  const ask = useCallback(() => fetchRepos(getToken), [getToken]);
  const list = useWardenCall<ReposResult>(ask, onSessionEnded);
  const { refresh, setResult } = list;
  const [starting, setStarting] = useState(false);
  // Set at the click itself, before React renders the disabled button: one start per click.
  const startRuns = useRef(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const answered = list.result !== "loading" && list.result.kind === "repos" ? list.result : null;
  // The last list read. While a Scan in it is under way, a read that fails keeps it on screen and the reading goes on.
  const [lastListed, setLastListed] = useState<Listed | null>(null);
  if (answered !== null && answered !== lastListed) setLastListed(answered);
  const listed = answered ?? (lastListed?.repos.some(isUnderWay) ? lastListed : null);
  const underWay = listed?.repos.some(isUnderWay) ?? false;

  // While a listed Scan is queued or running, the list is read again READ_AGAIN_MS after each answer, keeping it on
  // screen; an answer with none under way, an unreadable list with none shown, or leaving the page stops it.
  useEffect(() => {
    if (!underWay) return;
    const next = setTimeout(refresh, READ_AGAIN_MS);
    return () => clearTimeout(next);
  }, [underWay, list.result, refresh]);

  // Opened at `#setup-repos` (Findings' "Scan now" link, #342), the Repos heading comes into view once the list first
  // answers.
  useLandOnAnchor(list.result !== "loading", findReposHeading);

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
      // The started repos read the new Scan at once, so the button stays disabled until the list is read again.
      case "started":
        setResult((old) => withScan(old, result.scan));
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
      {startsScans(me.role) && (
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

/** `/setup/github`: the read app's Setup URL on GitHub, which names the installation just made in `installation_id`. */
export function GitHubSetupPage(props: PageProps) {
  return <ConnectPage {...props} words={READ_WORDS} />;
}

/** `/setup/github/write`: the write app's Setup URL on GitHub (#224, story 5), as `/setup/github` is the read app's. */
export function WriteAppSetupPage(props: PageProps) {
  return <ConnectPage {...props} words={WRITE_WORDS} />;
}

function ConnectPage(props: AppProps) {
  return (
    <>
      <h1>{props.words.app.heading}</h1>
      {props.me.role === "admin" ? (
        <LinkInstallation {...props} />
      ) : (
        <p className="muted">{props.words.onlyAdmin}</p>
      )}
    </>
  );
}

function LinkInstallation(props: AppProps) {
  const { words } = props;
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
      url = await startSignIn(clientId, id, words.app);
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
          {words.noInstallation}
        </p>
        {ready !== null ? (
          <p className="setup-link">
            <a href={installUrl(ready.slug)}>{words.install}</a>
          </p>
        ) : (
          <AppNotReady app={app} words={words} />
        )}
      </>
    );
  }
  return (
    <>
      <p>{words.through(installationId, teamName)}</p>
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
          {SIGN_IN}
        </button>
      ) : (
        <AppNotReady app={app} words={words} />
      )}
    </>
  );
}
