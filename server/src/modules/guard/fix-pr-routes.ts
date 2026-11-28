// The Fix PR route (#224, stories 5, 6 and 15), mounted by the app through `moduleRoutes` beside the write grant's
// (ADR 0005). A person in the Team opens a Fix PR from one of its Findings through the write app: a new branch
// `warden/fix-<Finding id>` from the default branch's head, one commit of the fixed file on it, and a PR into the
// default branch, never a write to the default branch. A second click answers the PR that's still open. A Fix PR opens
// only on one of the Team's own Repo Assets, whatever the write installation reaches (owner's answer A on #295). The
// Team and the person always come from the session, never the request.
import { setTimeout as delay } from "node:timers/promises";
import {
  STATUS_WORDS,
  type FindingFixPrBody,
  type FixPrBody,
  type Finding,
  type Location,
} from "@warden/contracts";
import type { Context } from "hono";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import { FindingNotFound, findingOf, type Findings } from "../../findings/index.ts";
import type { Logger } from "../../log.ts";
import { idParam } from "../../path-id.ts";
import { packRule } from "./default-pack.ts";
import { fixedEdit, fixRefusal, NO_FIX_PR } from "./fix-edits.ts";
import type { FixPr, FixPrs } from "./fix-prs.ts";
import { GitHubUnavailable } from "./github.ts";
import {
  BranchRefused,
  FileUnreadable,
  type GitHubWriter,
  type OpenedPull,
  type RepoToken,
  type RepoWriter,
} from "./github-writer.ts";
import { RegistryUnavailable, type PackageRegistry } from "./package-registry.ts";
import type { RepoAssets } from "./repo-assets.ts";
import { holdsWriteAppPermissions } from "./write-grant-routes.ts";
import type { WriteGrants } from "./write-grants.ts";

/** The POSTs a Team may send in an hour, counted before the Finding is read, so a refusal counts too. */
export const FIX_PRS_PER_HOUR = 20;

/**
 * How many times a click that finds the Fix PR branch already there looks for an open PR from it, and how long it
 * waits between looks: a click at once with another finds the branch the other just made, before the other's PR is
 * open, and waits for it rather than asking for the branch to be deleted.
 */
const PULL_LOOKS = 5;
const PULL_WAIT_MS = 1_000;

const NOT_SET_UP = "Fix PRs aren't set up on this Warden";
const GITHUB_DOWN = "GitHub didn't answer; no Fix PR was opened";
const REGISTRY_DOWN = { npm: "The npm registry", pypi: "The PyPI registry" } as const;

/** What answers a request: the route's own refusal, its status and words. */
type Refusal = { status: 400 | 409; error: string };

type FileLocation = Extract<Location, { kind: "file" }>;

function fixPrBody(fixPr: FixPr): FixPrBody {
  return {
    url: fixPr.url,
    number: fixPr.number,
    branch: fixPr.branch,
    opened_by: fixPr.openedBy,
    opened_at: fixPr.openedAt.toISOString(),
  };
}

/** A Status as a sentence ends with it: the contracts' words, with "a" before False positive. */
const statusInSentence = (status: Finding["status"]) =>
  status === "false_positive" ? `a ${STATUS_WORDS[status]}` : STATUS_WORDS[status];

/** The branch a Finding's Fix PR is opened from: one per Finding, so a second click finds it. */
const branchFor = (finding: Finding) => `warden/fix-${finding.id}`;

/** The 409 for a Fix PR branch already there with no open PR from it into the default branch. */
const branchInTheWay = (branch: string) =>
  `Branch ${branch} already exists on the repo with no open Fix PR from it; if one is being opened, try again in a minute, or else delete the branch to open a new Fix PR`;

/**
 * The 409 for an open PR from a Fix PR branch that the write app didn't make alone (#347): someone else opened it, or
 * pushed to it. Warden never takes it as its own.
 */
const notWardens = (number: number, branch: string) =>
  `PR #${number} from ${branch} wasn't opened by Warden's write app alone; close the PR and delete the branch to open a new Fix PR`;

/** The answer `work` gives, or 404 for a Finding the Team doesn't have, naming nothing of anyone's. */
async function refusing(c: Context<AppEnv>, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FindingNotFound) return c.json({ error: "No such Finding" }, 404);
    throw error;
  }
}

type Stores = {
  findings: Pick<Findings, "list">;
  repoAssets: Pick<RepoAssets, "list">;
  writeGrants: Pick<WriteGrants, "list" | "revoke">;
  fixPrs: FixPrs;
};

/**
 * The Fix PR routes. Opening one needs the write app's `writer`, which comes with the package registry its edits look
 * versions up in and the logger its failures are written to; without them, the POST answers 503 and the GET still
 * answers. `pullWait` is the wait between looks for an open PR, PULL_WAIT_MS unless a test gives its own.
 */
export function fixPrRoutes(
  deps: Stores &
    (
      | {
          writer: GitHubWriter;
          registry: PackageRegistry;
          logger: Logger;
          pullWait?: () => Promise<void>;
        }
      | { writer?: undefined; registry?: undefined; logger?: undefined; pullWait?: undefined }
    ),
): MountRoutes {
  const { findings, repoAssets, writeGrants, fixPrs } = deps;
  const pullWait = deps.pullWait ?? (() => delay(PULL_WAIT_MS));
  const limit = createAttemptLimit({ max: FIX_PRS_PER_HOUR, windowMs: 60 * 60_000 });

  /** The Team's Finding the path names, or FindingNotFound. */
  const pathFinding = (c: Context<AppEnv>) =>
    findingOf(findings, c.get("team"), idParam(c, FindingNotFound));

  /** The refusal the Finding alone gives, its Rule and Location then its Status; or the file Location it fixes. */
  function refusalOf(finding: Finding): { refusal: Refusal } | { location: FileLocation } {
    const { location } = finding;
    const refused = fixRefusal(finding.rule_id, location);
    if (refused !== undefined || location.kind !== "file") {
      return { refusal: { status: 400, error: refused ?? NO_FIX_PR } };
    }
    if (finding.status !== "open") {
      const error = `Only an Open Finding gets a Fix PR; this one is ${statusInSentence(finding.status)}`;
      return { refusal: { status: 409, error } };
    }
    return { location };
  }

  /** The first open PR from `branch` into the default branch, looked for PULL_LOOKS times; undefined if none shows. */
  async function openPullFrom(repo: RepoWriter, branch: string): Promise<OpenedPull | undefined> {
    for (let look = 1; ; look++) {
      const open = await repo.openPullWithHead(branch);
      if (open !== undefined || look === PULL_LOOKS) return open;
      await pullWait();
    }
  }

  return (app, requireRole) => {
    // Any person in the Team opens one (story 6). No body is read.
    app.post("/api/guard/findings/:id/fix-pr", requireRole("member"), async (c) => {
      if (deps.writer === undefined) return c.json({ error: NOT_SET_UP }, 503);
      const { writer, registry, logger } = deps;
      const team = c.get("team");
      const person = c.get("session").userId;
      const retryAfter = limit.attempt(team);
      if (retryAfter !== undefined) {
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: `A Team opens at most ${FIX_PRS_PER_HOUR} Fix PRs an hour` }, 429);
      }

      return refusing(c, async () => {
        const finding = await pathFinding(c);
        const fixable = refusalOf(finding);
        if ("refusal" in fixable)
          return c.json({ error: fixable.refusal.error }, fixable.refusal.status);
        const { location } = fixable;

        const asset =
          finding.asset.kind === "repo"
            ? (await repoAssets.list(team)).find((repo) => repo.ref === finding.asset.ref)
            : undefined;
        if (asset === undefined) {
          return c.json({ error: "This Finding's repo isn't one of the Team's Repo Assets" }, 409);
        }
        const grants = await writeGrants.list(team);
        if (grants.length === 0) {
          return c.json({ error: "Grant write access on Setup to open Fix PRs" }, 409);
        }

        try {
          // The first granted installation that gives a token for this one repo. One GitHub answers 404 for is gone,
          // so its grant is revoked; one that's suspended (403) or doesn't reach the repo (422) is only skipped.
          let token: Extract<RepoToken, { ok: true }> | undefined;
          let uninstalled = false;
          for (const grant of grants) {
            const answer = await writer.repoToken(grant.installationId, asset);
            if (answer.ok) {
              token = answer;
              break;
            }
            if (answer.status === 404) {
              const revoked = await writeGrants.revoke(team, {
                installationId: grant.installationId,
                revokedBy: person,
              });
              uninstalled ||= revoked;
            }
          }
          if (token === undefined) {
            return c.json(
              {
                error: uninstalled
                  ? "The write app was uninstalled from GitHub; grant write access again on Setup to open Fix PRs"
                  : "No write grant reaches this repo",
              },
              409,
            );
          }
          // The app's permissions may have changed on GitHub since the link: a token holding more, or less, writes
          // nothing.
          if (!holdsWriteAppPermissions(token.permissions)) {
            return c.json({ error: "This installation's permissions aren't the write app's" }, 409);
          }

          const repo = await token.open();
          const held = await fixPrs.newest(team, finding.id);
          if (held && (await repo.pullIsOpen(held.number))) {
            // A closed one reopened with someone else's commits on top is no longer Warden's.
            if (!(await repo.pullIsWardens(held.number))) {
              return c.json({ error: notWardens(held.number, held.branch) }, 409);
            }
            return c.json(fixPrBody(held), 200);
          }

          // The registry is asked here, before anything is written to GitHub.
          const current = await repo.readFile(location.path);
          const edit = await fixedEdit(finding.rule_id, location, current?.text, registry);
          if (!edit.ok) return c.json({ error: edit.reason }, 409);
          // An edit writes the Finding's own file, whose blob sha the commit names.
          if (edit.path !== location.path) {
            throw new Error("a fixed edit wrote a file other than its Finding's");
          }

          const branch = branchFor(finding);
          /** Records `pull` from the branch as the Finding's Fix PR, which writes nothing when it's held. */
          const record = (pull: OpenedPull) =>
            fixPrs.record(team, { findingId: finding.id, ...pull, branch, openedBy: person });

          // The branch already there was made by an earlier click: its open PR is answered when the write app made
          // it alone, or the branch is named and left as it is. A PR found that isn't Warden's is answered at once.
          if ((await repo.createBranch(branch)) === "exists") {
            const open = await openPullFrom(repo, branch);
            if (open === undefined) return c.json({ error: branchInTheWay(branch) }, 409);
            if (!(await repo.pullIsWardens(open.number))) {
              return c.json({ error: notWardens(open.number, branch) }, 409);
            }
            return c.json(fixPrBody(await record(open)), 200);
          }
          const title = `Fix: ${packRule(finding.rule_id).title}`;
          await repo.writeFile({
            branch,
            path: edit.path,
            text: edit.text,
            sha: current?.sha,
            message: title,
          });
          const opened = await repo.openPull({
            title,
            body: [
              `Warden opened this Fix PR for Finding \`${finding.id}\` (\`${finding.rule_id}\`).`,
              "",
              ...edit.body,
            ].join("\n"),
            head: branch,
          });
          const fixPr = await record(opened);
          logger.info("guard: Fix PR opened", { team, finding: finding.id, number: fixPr.number });
          return c.json(fixPrBody(fixPr), 201);
        } catch (error) {
          if (error instanceof FileUnreadable || error instanceof BranchRefused) {
            return c.json({ error: error.message }, 409);
          }
          if (error instanceof RegistryUnavailable) {
            const words = `${REGISTRY_DOWN[error.registry]} didn't answer; no Fix PR was opened`;
            logger.error(words, { team, registry: error.registry, status: error.status });
            return c.json({ error: words }, 502);
          }
          if (error instanceof GitHubUnavailable) {
            logger.error(GITHUB_DOWN, { team, step: error.step, status: error.status });
            return c.json({ error: GITHUB_DOWN }, 502);
          }
          throw error;
        }
      });
    });

    // Any person in the Team reads whether a Finding can get a Fix PR, and its newest one: the detail card's link
    // (slice 5). No GitHub call, so it answers the same without the write app.
    app.get("/api/guard/findings/:id/fix-pr", requireRole("member"), (c) =>
      refusing(c, async () => {
        const finding = await pathFinding(c);
        const newest = await fixPrs.newest(c.get("team"), finding.id);
        return c.json({
          fixable: fixRefusal(finding.rule_id, finding.location) === undefined,
          fix_pr: newest ? fixPrBody(newest) : null,
        } satisfies FindingFixPrBody);
      }),
    );
  };
}
