// The Setup page (Guard spec, story 1): an Admin connects GitHub from here, and anyone in the Team sees its Repo
// Assets. GitHub sends the Admin back from installing the app to `/setup/github`, its Setup URL, which asks them to
// sign in with GitHub so Warden can link that installation to the Team.
import { useOrganization } from "@clerk/react";
import { useCallback, useState } from "react";
import type { PageProps } from "./App.tsx";
import {
  fetchGitHubApp,
  fetchRepos,
  installationIdFrom,
  installUrl,
  startSignIn,
  type GitHubAppResult,
  type ReposResult,
} from "./github-setup.ts";
import { goTo } from "./navigate.ts";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

const ADMIN_CONNECTS = "An Admin connects GitHub.";
const NOT_SET_UP = "GitHub isn't set up on this Warden.";

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
  // A 403: the person's Role changed since /api/me answered, so the shell asks again.
  const notAdmin = app.result !== "loading" && app.result.kind === "not-admin";
  const [toldShell, setToldShell] = useState(false);
  if (notAdmin && !toldShell) {
    setToldShell(true);
    refreshMe();
  }
  return app;
}

/** What the App's answer shows besides the install link or the sign-in button: waiting, and each refusal. */
function AppRefused({ app }: { app: ReturnType<typeof useGitHubApp> }) {
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
  return <AppRefused app={app} />;
}

function RepoList({ getToken, onSessionEnded }: PageProps) {
  const ask = useCallback(() => fetchRepos(getToken), [getToken]);
  const list = useWardenCall<ReposResult>(ask, onSessionEnded);

  if (list.result === "loading") return <p className="muted">Loading the Team's repos…</p>;
  if (list.result.kind !== "repos") {
    return (
      <>
        <CallRefused result={list.result} onRetry={list.retry} />
        <TeamRefused result={list.result} />
      </>
    );
  }
  if (list.result.repos.length === 0) return <p className="muted">No repos linked yet.</p>;
  return (
    <ul className="repo-list">
      {list.result.repos.map((repo) => (
        <li key={repo.asset.ref}>{repo.asset.ref}</li>
      ))}
    </ul>
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
  const teamName = organization?.id === props.me.team ? organization.name : "your Team";
  const ready = app.result !== "loading" && app.result.kind === "app" ? app.result.app : null;

  async function signIn(clientId: string, id: number) {
    setLeaving(true);
    goTo(await startSignIn(clientId, id));
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
          <AppRefused app={app} />
        )}
      </>
    );
  }
  return (
    <>
      <p>
        Link installation {installationId} to {teamName}
      </p>
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
        <AppRefused app={app} />
      )}
    </>
  );
}
