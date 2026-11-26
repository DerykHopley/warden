// The tar reader over tarballs the tests build: it yields each regular file under GitHub's top folder, its long names
// from pax or GNU entries, skips and counts what a Scan can't read, and throws GitHubUnavailable for an archive past
// its limits or one that's malformed, without reading further.
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  chunks,
  file,
  gitHubTarball,
  gnuLongFile,
  link,
  paxFile,
  tar,
  TOP,
  type TarEntry,
} from "../../../test/tarballs.ts";
import { rejection } from "../../../test/helpers.ts";
import { GitHubUnavailable } from "./github.ts";
import type { RepoFile } from "./repo-reader.ts";
import { newArchiveCounts, readTarball, type ArchiveLimits } from "./tarball.ts";

const MiB = 1024 * 1024;

async function read(
  source: AsyncIterable<Uint8Array>,
  limits?: Partial<ArchiveLimits>,
): Promise<{ files: RepoFile[]; unread: string[]; counts: ReturnType<typeof newArchiveCounts> }> {
  const counts = newArchiveCounts();
  const files: RepoFile[] = [];
  const unread: string[] = [];
  for await (const entry of readTarball(source, { counts, limits })) {
    if ("text" in entry) files.push(entry);
    else unread.push(entry.path);
  }
  return { files, unread, counts };
}

const readAll = (entries: TarEntry[]) => read(chunks(gitHubTarball(entries)));

/** A source that counts how many chunks were pulled from it. */
function counted(bytes: Uint8Array, size: number) {
  const pulled = { chunks: 0 };
  async function* source() {
    for await (const chunk of chunks(bytes, size)) {
      pulled.chunks += 1;
      yield chunk;
    }
  }
  return { source: source(), pulled };
}

describe("readTarball", () => {
  it("yields each file with GitHub's top folder stripped, a ustar prefix joined, and its text", async () => {
    const { files, counts } = await readAll([
      file("README.md", "# Guarded\n"),
      { path: "src/config.ts", prefix: TOP, body: "export const a = 1;\n" },
      file(".claude/settings.local.json", "{}\n"),
    ]);

    expect(files).toEqual([
      { path: "README.md", text: "# Guarded\n" },
      { path: "src/config.ts", text: "export const a = 1;\n" },
      { path: ".claude/settings.local.json", text: "{}\n" },
    ]);
    expect(counts.files).toBe(3);
  });

  it("reads a path past ustar's 100 bytes from a pax path record and from a GNU long name", async () => {
    const deep = `${"nested/".repeat(16)}settings.json`;
    const deeper = `${"other/".repeat(20)}config.ts`;

    const { files } = await readAll([
      ...paxFile(deep, "pax\n"),
      ...gnuLongFile(deeper, "gnu\n"),
      file("after.txt", "after\n"),
    ]);

    expect(files).toEqual([
      { path: deep, text: "pax\n" },
      { path: deeper, text: "gnu\n" },
      { path: "after.txt", text: "after\n" },
    ]);
  });

  it("skips and counts a symlink, a directory, a binary file, a non-UTF-8 file, one over 1 MiB and a bad path, naming the files it couldn't read", async () => {
    const { files, unread, counts } = await readAll([
      file("kept.txt", "kept\n"),
      link("link", "/etc/passwd"),
      link("hard", `${TOP}/kept.txt`, "1"),
      { path: `${TOP}/src/`, type: "5" },
      file("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])),
      file("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])),
      file("big.txt", "a".repeat(MiB + 1)),
      file("exactly-1MiB.txt", "b".repeat(MiB)),
      file("../escape.txt", "escape\n"),
      file("a/../../escape.txt", "escape\n"),
      { path: "/etc/absolute.txt", body: "absolute\n" },
      file("back\\slash.txt", "slash\n"),
      file("C:/drive.txt", "drive\n"),
      { path: "no-top-folder.txt", body: "loose\n" },
      file("src/kept.ts", "export {};\n"),
    ]);

    expect(files.map((f) => f.path)).toEqual(["kept.txt", "exactly-1MiB.txt", "src/kept.ts"]);
    // A link, or a regular file whose text the Scan can't read, at a repo path: the Findings in it stay as they are.
    expect(unread).toEqual(["link", "hard", "image.png", "latin1.txt", "big.txt"]);
    expect(counts.files).toBe(3);
    // The top folder itself is a directory too.
    expect(counts.skipped).toEqual({
      notAFile: 4,
      tooLarge: 1,
      binary: 1,
      notUtf8: 1,
      badPath: 6,
    });
  });

  it("yields nothing for a link at a path that could escape the repo", async () => {
    const { files, unread, counts } = await readAll([
      file("settings.md", "# Settings\n"),
      link("../link", "/etc/passwd"),
      link("a/../../hard", `${TOP}/settings.md`, "1"),
      { path: "/etc/link", type: "2", linkname: "/etc/passwd" },
    ]);

    expect(files).toEqual([{ path: "settings.md", text: "# Settings\n" }]);
    expect(unread).toEqual([]);
    // The top folder and the three links.
    expect(counts.skipped).toMatchObject({ notAFile: 4, badPath: 0 });
  });

  it("counts the compressed and uncompressed bytes it read", async () => {
    const archive = gitHubTarball([file("a.txt", "a\n")]);

    const { counts } = await read(chunks(archive));

    expect(counts.compressedBytes).toBe(archive.length);
    expect(counts.uncompressedBytes).toBeGreaterThanOrEqual(5 * 512);
  });

  it("throws GitHubUnavailable past the compressed limit, pulling nothing more", async () => {
    // Random bytes don't compress, so the archive is about as big as they are.
    const archive = gitHubTarball([file("noise.bin", randomBytes(64 * 1024))]);
    expect(archive.length).toBeGreaterThan(40_000);
    const { source, pulled } = counted(archive, 1000);

    const error = await rejection(read(source, { compressedBytes: 10_000 }));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.message).toMatch(/past its 10000-byte compressed limit/);
    expect(pulled.chunks).toBe(11);
  });

  it("throws GitHubUnavailable past the uncompressed limit, reading no further", async () => {
    // The zeros pass the limit early; the random bytes after them are most of the download.
    const archive = gitHubTarball([
      file("zeros.txt", "0".repeat(2_000_000)),
      file("noise.bin", randomBytes(200_000)),
    ]);
    const { source, pulled } = counted(archive, 1000);

    const error = await rejection(read(source, { uncompressedBytes: 100_000 }));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.message).toMatch(/past its 100000-byte uncompressed limit/);
    expect(pulled.chunks).toBeLessThan(Math.ceil(archive.length / 1000) / 2);
  });

  it("throws GitHubUnavailable for a truncated archive", async () => {
    const archive = gitHubTarball([file("a.txt", "a".repeat(20_000))]);

    const error = await rejection(read(chunks(archive.subarray(0, archive.length - 40))));

    expect(error).toBeInstanceOf(GitHubUnavailable);
  });

  it("throws GitHubUnavailable for a whole gzip whose tar is cut short", async () => {
    const whole = tar([file("a.txt", "a".repeat(20_000))]);

    const error = await rejection(read(chunks(gzipSync(whole.subarray(0, 6000)))));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.message).toMatch(/cut short/);
  });

  it("throws GitHubUnavailable for something that isn't gzip", async () => {
    const error = await rejection(read(chunks(Buffer.from("<html>not an archive</html>"))));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.message).toMatch(/isn't a gzipped tar/);
  });

  it("throws GitHubUnavailable for a tar header whose checksum is wrong", async () => {
    const bytes = tar([file("a.txt", "a\n")]);
    bytes[0] = "b".charCodeAt(0);

    const error = await rejection(read(chunks(gzipSync(bytes))));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.message).toMatch(/header/);
  });

  it("throws GitHubUnavailable, keeping no cause, when its source is lost partway", async () => {
    const archive = gitHubTarball([file("a.txt", "a".repeat(20_000))]);
    async function* lost() {
      yield archive.subarray(0, 100);
      throw new TypeError("terminated https://codeload.github.com/x?token=secret");
    }

    const error = await rejection(read(lost()));

    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("secret");
  });
});
