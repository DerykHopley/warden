// A Team's Repo Assets (Guard spec, story 1), as the API answers them: each repo a linked GitHub installation lists,
// named by GitHub's URL for it. The Team comes from the session, never the request, and isn't answered.
import { z } from "zod";
import { Asset, DateTime } from "./finding.ts";

/** A GitHub installation's id: GitHub's are positive integers. */
const InstallationId = z.number().int().positive();

/** One of the Team's Repo Assets: the Asset, the GitHub installation that lists it, and when it was listed. */
export const RepoAssetBody = z.strictObject({
  asset: Asset.refine((asset) => asset.kind === "repo", "a Repo Asset's kind is repo"),
  installation_id: InstallationId,
  listed_at: DateTime,
});
export type RepoAssetBody = z.infer<typeof RepoAssetBody>;

/** `GET /api/repos`: the session's Team's Repo Assets, by ref; `{ repos: [] }` for a Team with none. */
export const ReposBody = z.strictObject({ repos: z.array(RepoAssetBody) });
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

/** The link's answer (201): the installation and its Repo Assets, the repos the linking person can read in it. */
export const LinkedInstallationBody = z.strictObject({
  installation_id: InstallationId,
  repos: z.array(RepoAssetBody),
});
export type LinkedInstallationBody = z.infer<typeof LinkedInstallationBody>;
