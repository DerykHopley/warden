// The port a Guard Scan reads a repo through (Guard spec, story 3). Tests fake it; slice 3b builds the GitHub one.
import type { GitHubRepo } from "./github.ts";

/** One of a repo's text files: its path relative to the repo, and its text. */
export type RepoFile = { path: string; text: string };

export interface RepoReader {
  /**
   * The repo's text files, one at a time, read through the installation the Team linked. Throws, before or during the
   * files, when the repo can't be read: a Scan reads a repo whole or not at all.
   */
  readRepo(installationId: number, repo: GitHubRepo): AsyncIterable<RepoFile>;
}
