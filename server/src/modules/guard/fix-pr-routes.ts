// The Fix PR route (#224, stories 5, 6 and 15), mounted by the app through `moduleRoutes` beside the write grant's
// (ADR 0005). A person in the Team opens a Fix PR from one of its Findings through the write app: a new branch
// `warden/fix-<Finding id>` from the default branch's head, one commit of the fixed file on it, and a PR into the
// default branch, never a write to the default branch. A second click answers the PR that's still open. A Fix PR opens
// only on one of the Team's own Repo Assets, whatever the write installation reaches (owner's answer A on #295). The
// Team and the person always come from the session, never the request.
import {
  STATUS_WORDS,
  type FindingFixPrBody,
  type FixPrBody,
  type Finding,
} from "@warden/contracts";
import type { Context } from "hono";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import { FindingNotFound, type Findings } from "../../findings/index.ts";
import type { Logger } from "../../log.ts";
import { idParam } from "../../path-id.ts";
import { packRule } from "./default-pack.ts";
import { fixedEdit, fixRefusal } from "./fix-edits.ts";
import type { FixPr, FixPrs } from "./fix-prs.ts";
import { GitHubUnavailable } from "./github.ts";
import { FileUnreadable, type GitHubWriter, type RepoWriter } from "./github-writer.ts";
import { RegistryUnavailable, type PackageRegistry } from "./package-registry.ts";
import type { RepoAssets } from "./repo-assets.ts";
import { holdsWriteAppPermissions } from "./write-grant-routes.ts";
import type { WriteGrants } from "./write-grants.ts";

/** The POSTs a Team may send in an hour, counted before the Finding is read, so a refusal counts too. */
export const FIX_PRS_PER_HOUR = 20;

const NOT_SET_UP = "Fix PRs aren't set up on this Warden";
const GITHUB_DOWN = "GitHub didn't answer; no Fix PR was opened";
const REGISTRY_DOWN = { npm: "The npm registry", pypi: "The PyPI registry" } as const;

/** What answers a request: the route's own refusal, its status and words. */
type Refusal = { status: 400 | 409; error: string };

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

type Stores = {
  findings: Pick<Findings, "list">;
  repoAssets: Pick<RepoAssets, "list">;
  writeGrants: Pick<WriteGrants, "list" | "revoke">;
  fixPrs: FixPrs;
};

/**
 * The Fix PR routes. Opening one needs the write app's `writer`, which comes with the package registry its edits look
 * versions up in and the logger its failures are written to; without them, the POST answers 503 and the GET still
 * answers.
 */
export function fixPrRoutes(
  deps: Stores &
    (
      | { writer: GitHubWriter; registry: PackageRegistry; logger: Logger }
      | { writer?: undefined; registry?: undefined; logger?: undefined }
    ),
): MountRoutes {
  const { findings, repoAssets, writeGrants, fixPrs } = deps;
  const limit = createAttemptLimit({ max: FIX_PRS_PER_HOUR, windowMs: 60 * 60_000 });

  /** The Team's Finding the path names, or FindingNotFound. The Findings module has no one-Finding read. */
  async function findingOf(c: Context<AppEnv>): Promise<Finding> {
    const id = idParam(c, FindingNotFound);
    const finding = (await findings.list(c.get("team"))).find((f) => f.id === id);
    if (finding === undefined) throw new FindingNotFound(id);
    return finding;
  }

  /** The refusal the Finding alone gives: its Rule and Location, then its Status; undefined when there's none. */
  function refusalOf(finding: Finding): Refusal | undefined {
    const refused = fixRefusal(finding.rule_id, finding.location);
    if (refused !== undefined) return { status: 400, error: refused };
    if (finding.status !== "open") {
      return {
        status: 409,
        error: `Only an Open Finding gets a Fix PR; this one is ${statusInSentence(finding.status)}`,
      };
    }
    return undefined;
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

      try {
        const finding = await findingOf(c);
        const refused = refusalOf(finding);
        if (refused) return c.json({ error: refused.error }, refused.status);
        const { location } = finding;
        if (location.kind !== "file") return c.json({ error: "no Fix PR for this Rule" }, 400);

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

        // The first granted installation that gives a token for this one repo. One GitHub answers 404 for is gone, so
        // its grant is revoked; one that's suspended (403) or doesn't reach the repo (422) is only skipped.
        let token: Awaited<ReturnType<GitHubWriter["repoToken"]>> | undefined;
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
        if (token === undefined || !token.ok) {
          return c.json(
            {
              error: uninstalled
                ? "The write app was uninstalled from GitHub; grant write access again on Setup to open Fix PRs"
                : "No write grant reaches this repo",
            },
            409,
          );
        }
        // The app's permissions may have changed on GitHub since the link: a token holding more, or less, writes nothing.
        if (!holdsWriteAppPermissions(token.permissions)) {
          return c.json({ error: "This installation's permissions aren't the write app's" }, 409);
        }

        const repo = await token.open();
        const held = await fixPrs.newest(team, finding.id);
        if (held && (await repo.pullIsOpen(held.number))) return c.json(fixPrBody(held), 200);

        // The registry is asked here, before anything is written to GitHub.
        const current = await repo.readFile(location.path);
        const edit = await fixedEdit(finding.rule_id, location, current?.text, registry);
        if (!edit.ok) return c.json({ error: edit.reason }, 409);
        // An edit writes the Finding's own file, whose blob sha the commit names.
        if (edit.path !== location.path)
          throw new Error("a fixed edit wrote a file other than its Finding's");

        const branch = branchFor(finding);
        if ((await repo.createBranch(branch)) === "exists") {
          return await branchThere(c, { repo, team, finding, branch, person });
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
        const fixPr = await fixPrs.record(team, {
          findingId: finding.id,
          ...opened,
          branch,
          openedBy: person,
        });
        logger.info("guard: Fix PR opened", { team, finding: finding.id, number: fixPr.number });
        return c.json(fixPrBody(fixPr) satisfies FixPrBody, 201);
      } catch (error) {
        if (error instanceof FindingNotFound) return c.json({ error: "No such Finding" }, 404);
        if (error instanceof FileUnreadable) return c.json({ error: error.message }, 409);
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

    // Any person in the Team reads whether a Finding can get a Fix PR, and its newest one: the detail card's link
    // (slice 5). No GitHub call, so it answers the same without the write app.
    app.get("/api/guard/findings/:id/fix-pr", requireRole("member"), async (c) => {
      try {
        const finding = await findingOf(c);
        const newest = await fixPrs.newest(c.get("team"), finding.id);
        return c.json({
          fixable: fixRefusal(finding.rule_id, finding.location) === undefined,
          fix_pr: newest ? fixPrBody(newest) : null,
        } satisfies FindingFixPrBody);
      } catch (error) {
        if (error instanceof FindingNotFound) return c.json({ error: "No such Finding" }, 404);
        throw error;
      }
    });
  };

  /**
   * The Fix PR branch is already on the repo: an earlier request made it. An open PR from it is answered (200) and
   * recorded, which writes nothing when it's held; with none, the branch is named and left as it is.
   */
  async function branchThere(
    c: Context<AppEnv>,
    {
      repo,
      team,
      finding,
      branch,
      person,
    }: { repo: RepoWriter; team: string; finding: Finding; branch: string; person: string },
  ) {
    const open = await repo.openPullWithHead(branch);
    if (open === undefined) {
      return c.json(
        { error: `Branch ${branch} already exists on the repo; delete it to open a new Fix PR` },
        409,
      );
    }
    const fixPr = await fixPrs.record(team, {
      findingId: finding.id,
      ...open,
      branch,
      openedBy: person,
    });
    return c.json(fixPrBody(fixPr) satisfies FixPrBody, 200);
  }
}
