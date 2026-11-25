// A Team's Repo Assets (stories 1, 15): the GitHub installations a Team linked and the repos each lists, stored by the
// Guard module's store on the suite's shared database through withTeam, and Guard's check of a Scan start's Assets.
// Each case has Teams and installation ids of its own, so files running at once never meet.
import type { Asset } from "@warden/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import {
  createRepoAssets,
  guardAssetCheck,
  InstallationLinkedElsewhere,
  type RepoAssets,
} from "../src/modules/guard/repo-assets.ts";
import { createWithTeam, type WithTeam } from "../src/with-team.ts";
import { poolAs } from "./databases.ts";
import { ADMIN, linkRepos, newInstallation, newTeam, repoRef } from "./helpers.ts";

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

const repo = (name: string, githubId: number) => ({ ref: repoRef(name), githubId });
const asRepo = (name: string): Asset => ({ kind: "repo", ref: repoRef(name) });

/** The Team's installations, read as that Team. */
const installations = (team: string) =>
  withTeam(team, (tx) => tx.selectFrom("github_installations").selectAll().execute());

describe("link and list", () => {
  it("records an installation and its repos for a Team, and lists them by ref", async () => {
    const team = await newTeam(withTeam);
    const installationId = newInstallation();

    await repoAssets.link(team, {
      installationId,
      linkedBy: ADMIN,
      repos: [repo("web", 2), repo("api", 1)],
    });

    expect(await repoAssets.list(team)).toEqual([
      { ref: repoRef("api"), githubId: 1, installationId, listedAt: expect.any(Date) },
      { ref: repoRef("web"), githubId: 2, installationId, listedAt: expect.any(Date) },
    ]);
    expect(await installations(team)).toMatchObject([
      { team_id: team, linked_by: ADMIN, linked_at: expect.any(Date) },
    ]);
  });

  it("records a repo listed twice once: GitHub's paged list can repeat one", async () => {
    const team = await newTeam(withTeam);

    await repoAssets.link(team, {
      installationId: newInstallation(),
      linkedBy: ADMIN,
      repos: [repo("api", 1), repo("web", 2), repo("api", 1)],
    });

    expect((await repoAssets.list(team)).map((row) => row.ref)).toEqual([
      repoRef("api"),
      repoRef("web"),
    ]);
  });

  it("lists nothing for a Team with no installation", async () => {
    expect(await repoAssets.list(await newTeam(withTeam))).toEqual([]);
  });

  it("replaces the installation's repos on a second link by the same Team, and updates who linked it", async () => {
    const team = await newTeam(withTeam);
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

    expect((await repoAssets.list(team)).map((row) => row.ref)).toEqual([
      repoRef("docs"),
      repoRef("web"),
    ]);
    expect(await installations(team)).toMatchObject([{ linked_by: "user_other_admin" }]);
  });

  it("keeps another installation's repos when one installation is relinked", async () => {
    const team = await newTeam(withTeam);
    const first = await linkRepos(repoAssets, team, [repoRef("api")]);
    const second = await linkRepos(repoAssets, team, [repoRef("ops")]);

    await repoAssets.link(team, { installationId: first, linkedBy: ADMIN, repos: [] });

    expect(await repoAssets.list(team)).toMatchObject([
      { ref: repoRef("ops"), installationId: second },
    ]);
  });

  it("refuses Team B's link of an installation Team A linked with InstallationLinkedElsewhere, writing nothing and leaving Team A's rows", async () => {
    const teamA = await newTeam(withTeam);
    const teamB = await newTeam(withTeam);
    const installationId = await linkRepos(repoAssets, teamA, [repoRef("api")]);
    const before = {
      list: await repoAssets.list(teamA),
      installations: await installations(teamA),
    };

    await expect(
      repoAssets.link(teamB, { installationId, linkedBy: ADMIN, repos: [repo("api", 1)] }),
    ).rejects.toBeInstanceOf(InstallationLinkedElsewhere);

    expect(await repoAssets.list(teamA)).toEqual(before.list);
    expect(await installations(teamA)).toEqual(before.installations);
    expect(await repoAssets.list(teamB)).toEqual([]);
    expect(await installations(teamB)).toEqual([]);
  });
});

describe("outside: the Assets a Team doesn't hold", () => {
  it("answers nothing when every Asset is one of the Team's Repo Assets", async () => {
    const team = await newTeam(withTeam);
    await linkRepos(repoAssets, team, [repoRef("api"), repoRef("web")]);

    expect(await repoAssets.outside(team, [asRepo("web"), asRepo("api")])).toEqual([]);
  });

  it("answers another Team's repo, a repo no Team holds and any Asset not a repo, in the order given", async () => {
    const team = await newTeam(withTeam);
    const other = await newTeam(withTeam);
    await linkRepos(repoAssets, team, [repoRef("api")]);
    await linkRepos(repoAssets, other, [repoRef("theirs")]);
    const product: Asset = { kind: "product", ref: repoRef("api") };

    expect(
      await repoAssets.outside(team, [asRepo("theirs"), asRepo("api"), product, asRepo("nobody")]),
    ).toEqual([asRepo("theirs"), product, asRepo("nobody")]);
  });

  it("answers Assets none of which is a repo without reading the database", async () => {
    const noDatabase: WithTeam = () => Promise.reject(new Error("read the database"));
    const product: Asset = { kind: "product", ref: repoRef("api") };

    expect(await createRepoAssets({ withTeam: noDatabase }).outside("org_x", [product])).toEqual([
      product,
    ]);
  });

  it("matches a ref exactly: another spelling of the same repo is outside", async () => {
    const team = await newTeam(withTeam);
    await linkRepos(repoAssets, team, [repoRef("api")]);
    const spellings: Asset[] = [
      { kind: "repo", ref: `${repoRef("api")}/` },
      { kind: "repo", ref: repoRef("API") },
      { kind: "repo", ref: `${repoRef("api")}.git` },
    ];

    expect(await repoAssets.outside(team, spellings)).toEqual(spellings);
  });
});

describe("guardAssetCheck: the refusal of a Guard Scan's first Asset outside, worded for the Lead", () => {
  /** Guard's check over a store whose `outside` answers `outside`. */
  const checkOver = (outside: Asset[]) => guardAssetCheck({ outside: async () => outside });

  it("answers nothing when every Asset is one of the Team's Repo Assets", async () => {
    expect(await checkOver([])("org_x", [asRepo("api")])).toBeUndefined();
  });

  it("names a repo the Team doesn't hold by its place and its ref", async () => {
    const check = checkOver([asRepo("theirs"), asRepo("nobody")]);

    expect(await check("org_x", [asRepo("api"), asRepo("theirs"), asRepo("nobody")])).toBe(
      `assets[1]: ${repoRef("theirs")} isn't one of your Team's repos`,
    );
  });

  it("names an Asset not a repo by its place and its kind, not its ref, which may be a Repo Asset's", async () => {
    const product: Asset = { kind: "product", ref: repoRef("api") };

    expect(await checkOver([product])("org_x", [asRepo("api"), product])).toBe(
      "a Guard Scan names only Repo Assets: assets[1] is a product",
    );
  });
});
