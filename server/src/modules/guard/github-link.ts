// What both of Warden's GitHub apps' routes share: the read app's in Guard's routes and the write app's in the write
// grant's (#224). Each app's Connect step answers its own slug and client id, and each app's link checks the Admin's
// own sign-in and the App's token the same way, with its own permissions, store and wording.
import { LinkInstallationBody, type GitHubAppBody } from "@warden/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import type { Logger } from "../../log.ts";
import { refusedBody } from "../../refused-body.ts";
import { SCANS_PER_HOUR } from "../../scans.ts";
import {
  GitHubInstallationUnreachable,
  GitHubRefusedCode,
  GitHubUnavailable,
  type GitHub,
  type UserRepo,
} from "./github.ts";
import { InstallationLinkedElsewhere } from "./repo-assets.ts";

/** Which of Warden's GitHub apps a route goes through, named in its log lines so an operator knows whose keys to check. */
export type GitHubAppName = "read" | "write";

/** One app's client, with the logger its failures are written to; neither when the app's settings aren't set here. */
export type GitHubClient =
  { github: GitHub; logger: Logger } | { github?: undefined; logger?: Logger };

/** Link attempts a Team may make in an hour, per app: the number of Scans it may start. */
export const LINKS_PER_HOUR = SCANS_PER_HOUR;

/**
 * Whether an installation token's `permissions` are among `expected`, each at its level; with `exact`, all of them and
 * nothing else. Fails closed: a token naming no permissions never matches, since what it can do isn't known.
 */
export function permissionsMatch(
  expected: Record<string, string>,
  permissions: Record<string, string>,
  { exact }: { exact: boolean },
) {
  const named = Object.entries(permissions);
  return (
    named.length > 0 &&
    (!exact || named.length === Object.keys(expected).length) &&
    named.every(([name, level]) => expected[name] === level)
  );
}

/** How long the App's slug is kept before GitHub is asked again, so a renamed App's links follow within the hour. */
const SLUG_KEPT_MS = 3_600_000;

/**
 * A handler answering the app's GitHubAppBody, what a Setup page builds GitHub's install and sign-in links from, or
 * 503 with `notSetUp` without the app's client. The slug is read from GitHub and kept for an hour from when the read
 * began, by `now`; a read that fails isn't kept, so the next call asks again, and calls while a read runs share it.
 * GitHub not answering is 502, logged with the app, step and status only. Each app's route builds its own, so each
 * keeps its own slug.
 */
export function gitHubAppRoute(
  app: GitHubAppName,
  client: GitHubClient,
  notSetUp: string,
  now: () => number,
) {
  let slug: { read: Promise<string>; at: number } | undefined;
  return async (c: Context<AppEnv>) => {
    if (client.github === undefined) return c.json({ error: notSetUp }, 503);
    const { github, logger } = client;
    if (slug === undefined || now() - slug.at >= SLUG_KEPT_MS) {
      const reading = {
        at: now(),
        read: github.appSlug().catch((error: unknown) => {
          if (slug === reading) slug = undefined;
          throw error;
        }),
      };
      slug = reading;
    }
    try {
      return c.json({ slug: await slug.read, client_id: github.clientId } satisfies GitHubAppBody);
    } catch (error) {
      if (!(error instanceof GitHubUnavailable)) throw error;
      // The step and status only, as the link logs them.
      logger.error("GitHub didn't answer", {
        team: c.get("team"),
        app,
        step: error.step,
        status: error.status,
      });
      return c.json({ error: "GitHub didn't answer" }, 502);
    }
  };
}

/** A link GitHub has confirmed: the Team, the installation, who links it, and the repos they read in it. */
export type Linking = {
  team: string;
  installationId: number;
  linkedBy: string;
  repos: UserRepo[];
};

/**
 * A handler linking an installation of one app to the session's Team. Without the app's client it answers 503 with
 * `notSetUp`; then a bad body 400, and a Team past LINKS_PER_HOUR links in an hour 429 with Retry-After, both before
 * GitHub is called. GitHub then confirms, with the person's own sign-in, that they reach the installation (403 when
 * they don't), and the App's token must hold what `permitted` allows (409 with `notPermitted`). With `mayLink`, the
 * person must also pass its `check` of what they read in the installation (403 with its `refused`). `link` writes the
 * app's store; another Team's installation answers 409 with `linkedElsewhere`, and `answer` answers what `link`
 * wrote. A refused sign-in is 400, an installation the App can't reach 409, and GitHub not answering 502, logged with
 * the app, step and status only. Every refusal writes nothing, and neither token is kept. Each route builds its own,
 * so each app counts its links apart.
 */
export function gitHubLinkRoute<Linked>(options: {
  app: GitHubAppName;
  client: GitHubClient;
  notSetUp: string;
  permitted: (permissions: Record<string, string>) => boolean;
  notPermitted: string;
  mayLink?: {
    check: (
      linking: { installationId: number; repos: UserRepo[] },
      github: GitHub,
    ) => Promise<boolean>;
    refused: string;
  };
  linkedElsewhere: string;
  link: (linking: Linking) => Promise<Linked>;
  answer: (
    c: Context<AppEnv>,
    linked: Linked,
    linking: Linking & { logger: Logger },
  ) => Response | Promise<Response>;
}) {
  const { app, client } = options;
  // Kept in this instance's memory, keyed by Team id as it is: each Cloud Run instance counts on its own (threat A5).
  const linkLimit = createAttemptLimit({ max: LINKS_PER_HOUR, windowMs: 3_600_000 });

  return async (c: Context<AppEnv>) => {
    if (client.github === undefined) return c.json({ error: options.notSetUp }, 503);
    const { github, logger } = client;
    // A body that isn't JSON parses as undefined, which the schema refuses.
    const parsed = LinkInstallationBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: refusedBody(parsed.error) }, 400);
    const team = c.get("team");
    const retryAfter = linkLimit.attempt(team);
    if (retryAfter !== undefined) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: `A Team links at most ${LINKS_PER_HOUR} times an hour` }, 429);
    }

    const { installation_id: installationId, code, code_verifier: codeVerifier } = parsed.data;
    let linking: Linking;
    let linked: Linked;
    try {
      const repos = await github.userInstallationRepos(code, codeVerifier, installationId);
      if (repos === undefined) {
        return c.json({ error: "You can't reach this installation on GitHub" }, 403);
      }
      if (!options.permitted(await github.installationPermissions(installationId))) {
        return c.json({ error: options.notPermitted }, 409);
      }
      if (options.mayLink && !(await options.mayLink.check({ installationId, repos }, github))) {
        return c.json({ error: options.mayLink.refused }, 403);
      }
      linking = { team, installationId, linkedBy: c.get("session").userId, repos };
      linked = await options.link(linking);
    } catch (error) {
      if (error instanceof GitHubRefusedCode) {
        return c.json({ error: "GitHub refused the sign-in; connect again" }, 400);
      }
      if (error instanceof GitHubInstallationUnreachable) {
        return c.json(
          { error: "The app can't reach this installation on GitHub; nothing was linked" },
          409,
        );
      }
      if (error instanceof InstallationLinkedElsewhere) {
        // The store's own message is the read app's, so each app answers its own.
        return c.json({ error: options.linkedElsewhere }, 409);
      }
      if (error instanceof GitHubUnavailable) {
        // The step and status only: GitHub's own words in the message aren't repeated.
        logger.error("GitHub didn't answer; nothing was linked", {
          team,
          app,
          step: error.step,
          status: error.status,
        });
        return c.json({ error: "GitHub didn't answer; nothing was linked" }, 502);
      }
      throw error;
    }
    return options.answer(c, linked, { ...linking, logger });
  };
}
