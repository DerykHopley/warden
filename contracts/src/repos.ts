// A Team's Repo Assets (Guard spec, story 1), as the API answers them: each repo a linked GitHub installation lists,
// named by GitHub's URL for it. The Team comes from the session, never the request, and isn't answered.
import { z } from "zod";
import { Asset, DateTime } from "./finding.ts";
import { ScanBody } from "./scans.ts";

/** A GitHub installation's id: GitHub's are positive integers. */
const InstallationId = z.number().int().positive();

/** One of the Team's Repo Assets: the Asset, the GitHub installation that lists it, and when it was listed. */
export const RepoAssetBody = z.strictObject({
  asset: Asset.refine((asset) => asset.kind === "repo", "a Repo Asset's kind is repo"),
  installation_id: InstallationId,
  listed_at: DateTime,
});
export type RepoAssetBody = z.infer<typeof RepoAssetBody>;

/**
 * A Repo Asset as `GET /api/repos` lists it (story 2): with its last Scan, the newest Guard Scan naming its ref, or null
 * when none does.
 */
export const ListedRepoBody = RepoAssetBody.extend({ last_scan: ScanBody.nullable() });
export type ListedRepoBody = z.infer<typeof ListedRepoBody>;

/** `GET /api/repos`: the session's Team's Repo Assets, by ref; `{ repos: [] }` for a Team with none. */
export const ReposBody = z.strictObject({ repos: z.array(ListedRepoBody) });
export type ReposBody = z.infer<typeof ReposBody>;

/**
 * `POST /api/github/installations`: an Admin links a GitHub installation to their Team, with the `code` GitHub's sign-in
 * gave and its PKCE `code_verifier` (43 to 128 characters, RFC 7636 4.1), so GitHub confirms the person can reach it.
 */
export const LinkInstallationBody = z.strictObject({
  installation_id: InstallationId,
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
});
export type LinkInstallationBody = z.infer<typeof LinkInstallationBody>;

/**
 * `GET /api/github/app` (Admin only): what the dashboard builds GitHub's links from. The `slug` names the App's install
 * page (`https://github.com/apps/<slug>/installations/new`); the `client_id` starts its sign-in.
 */
export const GitHubAppBody = z.strictObject({
  slug: z.string().min(1),
  client_id: z.string().min(1),
});
export type GitHubAppBody = z.infer<typeof GitHubAppBody>;

/**
 * The link's answer (201): the installation and its Repo Assets, the repos the linking person can read in it, and the
 * first Scan of them the link started (story 2): `null` when it started none, as for a link of no repos or a Team at
 * its hourly Scan limit.
 */
export const LinkedInstallationBody = z.strictObject({
  installation_id: InstallationId,
  repos: z.array(RepoAssetBody),
  scan: ScanBody.nullable(),
});
export type LinkedInstallationBody = z.infer<typeof LinkedInstallationBody>;

/**
 * A Team's write grant (#224, story 5): an installation of Warden's write GitHub app, which Fix PRs go through, who
 * granted it (a Clerk user id) and when. `POST /api/github/write-installations` (Admin only) answers one: 201 for a new
 * grant, 200 for one the Team already held. Its body is a `LinkInstallationBody` from the write app's sign-in. The
 * write app's own `GET /api/github/write-app` answers a `GitHubAppBody`.
 */
export const WriteGrantBody = z.strictObject({
  installation_id: InstallationId,
  granted_by: z.string().min(1),
  granted_at: DateTime,
});
export type WriteGrantBody = z.infer<typeof WriteGrantBody>;

/** `GET /api/github/write-grant` (any person in the Team): its write grants, `{ installations: [] }` for none. */
export const WriteGrantsBody = z.strictObject({ installations: z.array(WriteGrantBody) });
export type WriteGrantsBody = z.infer<typeof WriteGrantsBody>;

/**
 * A Fix PR the write app opened for a Finding (#224, story 6): GitHub's URL for it and its number, its branch, who
 * opened it (a Clerk user id) and when. `POST /api/guard/findings/:id/fix-pr` (any person in the Team) answers one:
 * 201 for a PR it opened, 200 for the Finding's PR that's still open. No body is sent.
 */
export const FixPrBody = z.strictObject({
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  number: z.number().int().positive(),
  branch: z.string().min(1),
  opened_by: z.string().min(1),
  opened_at: DateTime,
});
export type FixPrBody = z.infer<typeof FixPrBody>;

/**
 * `GET /api/guard/findings/:id/fix-pr` (any person in the Team): whether the Finding's Rule and Location can get a Fix
 * PR, and its newest Fix PR, or `null` when it has none.
 */
export const FindingFixPrBody = z.strictObject({
  fixable: z.boolean(),
  fix_pr: FixPrBody.nullable(),
});
export type FindingFixPrBody = z.infer<typeof FindingFixPrBody>;
