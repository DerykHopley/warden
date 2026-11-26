// No whole secret in Warden's own tracked files (#316). Every file `git ls-files` names is read as a Guard Scan reads
// a repo's archive, and scanned with the Default Pack's secret Rules: a Team that linked Warden's repo would see a
// `guard/secret-in-repo` Finding for each secret found. A test's made-up secret is built from parts instead
// (`secret-fixtures.ts`). The working tree is read, so an uncommitted secret fails the run before it's committed.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { secretObservations } from "../src/modules/guard/secrets.ts";
import { ARCHIVE_LIMITS } from "../src/modules/guard/tarball.ts";
import { AWS_KEY } from "./secret-fixtures.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const warden: Asset = { kind: "repo", ref: "https://github.com/example/warden" };

/** How far into a file a NUL marks it binary, as Guard's archive reader looks. */
const BINARY_SNIFF_BYTES = 8 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's text as a Guard Scan reads it, or undefined for a file the Scan leaves unread: one over the file limit, a
 * binary one (a NUL in its first 8 KiB, as an `.xlsx` holds) or one that isn't UTF-8.
 */
function scannedText(bytes: Uint8Array): string | undefined {
  if (bytes.length > ARCHIVE_LIMITS.fileBytes) return undefined;
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Each tracked file's path, from the repo root, with the text a Scan reads, or undefined when it leaves the file
 * unread. A path that isn't a regular file in the working tree (a symlink, a submodule, a file deleted but not yet
 * committed) is left out, as Guard never reads one.
 */
function trackedFiles(): { path: string; text: string | undefined }[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
  return paths
    .filter((path) => lstatSync(join(repoRoot, path), { throwIfNoEntry: false })?.isFile())
    .map((path) => ({ path, text: scannedText(readFileSync(join(repoRoot, path))) }));
}

describe("scannedText", () => {
  it("reads UTF-8 text, and leaves a binary file, a non-UTF-8 one and one past the file limit unread", () => {
    const text = new TextEncoder().encode(`const key = "${AWS_KEY}"; // ü\n`);
    const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, ...text]);
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const large = new Uint8Array(ARCHIVE_LIMITS.fileBytes + 1).fill(0x61);

    expect(scannedText(text)).toBe(`const key = "${AWS_KEY}"; // ü\n`);
    expect([binary, latin1, large].map(scannedText)).toEqual([undefined, undefined, undefined]);
  });
});

describe("Warden's tracked files", () => {
  it("hold no whole secret a Guard Scan would report", () => {
    const files = trackedFiles();
    const found = files.flatMap(({ path, text }) =>
      text === undefined
        ? []
        : secretObservations(warden, { path, text }).map(
            ({ rule_id, evidence }) => `${rule_id}: ${evidence.summary}`,
          ),
    );

    // A listing that came back empty, or a reader that skipped every file, would pass with nothing scanned.
    expect(files.filter(({ text }) => text !== undefined).map(({ path }) => path)).toContain(
      "server/test/secret-fixtures.ts",
    );
    expect(found).toEqual([]);
  });
});
