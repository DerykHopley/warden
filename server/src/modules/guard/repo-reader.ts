// The port a Guard Scan reads a repo through (Guard spec, story 3). Tests fake it; slice 3b builds the GitHub one.
import type { GitHubRepo } from "./github.ts";

/** One of a repo's text files: its path relative to the repo, and its text. */
export type RepoFile = { path: string; text: string };

/**
 * One of a repo's files whose text the reader couldn't read (too large, binary, not UTF-8): what it holds now is
 * unknown, so the Findings in it stay as they are.
 */
export type UnreadFile = { path: string; unread: true };

export interface RepoReader {
  /**
   * The repo's files, one at a time, read through the installation the Team linked: each text file, and each file it
   * couldn't read as text. A repo with no commits yields nothing, as a repo with no files. Throws, before or during the
   * files, when the repo can't be read: a Scan reads a repo whole or not at all.
   */
  readRepo(installationId: number, repo: GitHubRepo): AsyncIterable<RepoFile | UnreadFile>;
}
