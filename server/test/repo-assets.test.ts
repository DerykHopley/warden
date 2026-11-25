// A Team's Repo Assets (stories 1, 15): the GitHub installations a Team linked and the repos each lists, stored by the
// Guard module's store on the suite's shared database through withTeam. Each case has Teams and installation ids of its
// own, so files running at once never meet.
import { randomInt, randomUUID } from "node:crypto";
import type { Asset } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import {
  createRepoAssets,
  InstallationLinkedElsewhere,
  type RepoAssets,
} from "../src/modules/guard/repo-assets.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { refusal, seedTeam } from "./helpers.ts";

let pool: pg.Pool;
let withTeam: WithTeam;
let repoAssets: RepoAssets;

beforeAll(() => {
  pool = poolAs("warden_app", inject("testDatabase"));
  withTeam = createWithTeam(pool);
  repoAssets = createRepoAssets({ withTeam });
});

afterAll(async () => {
  await pool.end();
});

const ADMIN = "user_admin";

async function newTeam() {
  const team = `org_repos_${randomUUID()}`;
  await seedTeam(withTeam, team, [[ADMIN, "admin"]]);
  return team;
}

/** An installation id no other case uses: GitHub's are positive integers. */
const newInstallation = () => randomInt(1, 2 ** 47);

const url = (name: string) => `https://github.com/example/${name}`;
const repo = (name: string, githubId: number) => ({ ref: url(name), githubId });
const asRepo = (name: string): Asset => ({ kind: "repo", ref: url(name) });

/** The Team's installations, read as that Team. */
const installations = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("github_installations").selectAll().execute());

describe("link and list", () => {
  it("records an installation and its repos for a Team, and lists them by ref", async () => {
    const team = await newTeam();
    const installationId = newInstallation();

    await repoAssets.link(team, {
      installationId,
      linkedBy: ADMIN,
      repos: [repo("web", 2), repo("api", 1)],
    });

    expect(await repoAssets.list(team)).toEqual([
      { ref: url("api"), githubId: 1, installationId, listedAt: expect.any(Date) },
      { ref: url("web"), githubId: 2, installationId, listedAt: expect.any(Date) },
    ]);
    expect(await installations(team)).toMatchObject([
      { team_id: team, linked_by: ADMIN, linked_at: expect.any(Date) },
    ]);
  });

  it("lists nothing for a Team with no installation", async () => {
    expect(await repoAssets.list(await newTeam())).toEqual([]);
  });

  it("replaces the installation's repos on a second link by the same Team, and updates who linked it", async () => {
    const team = await newTeam();
    const installationId = newInstallation();
    await repoAssets.link(team, {
      installationId,
      linkedBy: ADMIN,
      repos: [repo("api", 1), repo("web", 2)],
    });

    await repoAssets.link(team, {
      installationId,
      linkedBy: "user_other_admin",
      repos: [repo("web", 2), repo("docs", 3)],
    });

    expect((await repoAssets.list(team)).map((row) => row.ref)).toEqual([url("docs"), url("web")]);
    expect(await installations(team)).toMatchObject([{ linked_by: "user_other_admin" }]);
  });

  it("keeps another installation's repos when one installation is relinked", async () => {
    const team = await newTeam();
    const first = newInstallation();
    const second = newInstallation();
    await repoAssets.link(team, {
      installationId: first,
      linkedBy: ADMIN,
      repos: [repo("api", 1)],
    });
    await repoAssets.link(team, {
      installationId: second,
      linkedBy: ADMIN,
      repos: [repo("ops", 9)],
    });

    await repoAssets.link(team, { installationId: first, linkedBy: ADMIN, repos: [] });

    expect(await repoAssets.list(team)).toMatchObject([
      { ref: url("ops"), installationId: second },
    ]);
  });

  it("refuses Team B's link of an installation Team A linked, writing nothing and leaving Team A's rows", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    const installationId = newInstallation();
    await repoAssets.link(teamA, { installationId, linkedBy: ADMIN, repos: [repo("api", 1)] });
    const before = {
      list: await repoAssets.list(teamA),
      installations: await installations(teamA),
    };

    expect(
      await refusal(
        repoAssets.link(teamB, { installationId, linkedBy: ADMIN, repos: [repo("api", 1)] }),
      ),
    ).toMatchObject({ name: "InstallationLinkedElsewhere" });

    expect(await repoAssets.list(teamA)).toEqual(before.list);
    expect(await installations(teamA)).toEqual(before.installations);
    expect(await repoAssets.list(teamB)).toEqual([]);
    expect(await installations(teamB)).toEqual([]);
  });

  it("throws the InstallationLinkedElsewhere class, so a caller can tell it apart", async () => {
    const teamA = await newTeam();
    const teamB = await newTeam();
    const installationId = newInstallation();
    await repoAssets.link(teamA, { installationId, linkedBy: ADMIN, repos: [] });

    await expect(
      repoAssets.link(teamB, { installationId, linkedBy: ADMIN, repos: [] }),
    ).rejects.toBeInstanceOf(InstallationLinkedElsewhere);
  });
});

describe("outside: the Assets a Team doesn't hold", () => {
  it("answers nothing when every Asset is one of the Team's Repo Assets", async () => {
    const team = await newTeam();
    await repoAssets.link(team, {
      installationId: newInstallation(),
      linkedBy: ADMIN,
      repos: [repo("api", 1), repo("web", 2)],
    });

    expect(await repoAssets.outside(team, [asRepo("web"), asRepo("api")])).toEqual([]);
  });

  it("answers another Team's repo, a repo no Team holds and any Asset not a repo, in the order given", async () => {
    const team = await newTeam();
    const other = await newTeam();
    await repoAssets.link(team, {
      installationId: newInstallation(),
      linkedBy: ADMIN,
      repos: [repo("api", 1)],
    });
    await repoAssets.link(other, {
      installationId: newInstallation(),
      linkedBy: ADMIN,
      repos: [repo("theirs", 5)],
    });
    const product: Asset = { kind: "product", ref: url("api") };

    expect(
      await repoAssets.outside(team, [asRepo("theirs"), asRepo("api"), product, asRepo("nobody")]),
    ).toEqual([asRepo("theirs"), product, asRepo("nobody")]);
  });

  it("matches a ref exactly: another spelling of the same repo is outside", async () => {
    const team = await newTeam();
    await repoAssets.link(team, {
      installationId: newInstallation(),
      linkedBy: ADMIN,
      repos: [repo("api", 1)],
    });
    const spellings: Asset[] = [
      { kind: "repo", ref: `${url("api")}/` },
      { kind: "repo", ref: url("API") },
      { kind: "repo", ref: `${url("api")}.git` },
    ];

    expect(await repoAssets.outside(team, spellings)).toEqual(spellings);
  });
});
