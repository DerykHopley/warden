// A Team's Repo Assets (Guard spec, story 1), as the API answers them: each repo a linked GitHub installation lists,
// named by GitHub's URL for it. The Team comes from the session, never the request, and isn't answered.
import { z } from "zod";
import { Asset, DateTime } from "./finding.ts";

/** One of the Team's Repo Assets: the Asset, the GitHub installation that lists it, and when it was listed. */
export const RepoAssetBody = z.strictObject({
  asset: Asset.refine((asset) => asset.kind === "repo", "a Repo Asset's kind is repo"),
  installation_id: z.number().int().positive(),
  listed_at: DateTime,
});
export type RepoAssetBody = z.infer<typeof RepoAssetBody>;

/** `GET /api/repos`: the session's Team's Repo Assets, by ref; `{ repos: [] }` for a Team with none. */
export const ReposBody = z.strictObject({ repos: z.array(RepoAssetBody) });
export type ReposBody = z.infer<typeof ReposBody>;
