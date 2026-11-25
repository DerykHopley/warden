// The tar reader a Guard Scan reads a repo's archive with (Guard spec, stories 3 and 15): a gzipped tarball as GitHub
// serves one, read as a stream on Node's zlib, yielding each regular file's path and text one at a time. GitHub puts
// every file under one `<owner>-<repo>-<sha>/` folder, which is stripped. Long names come from pax `path` records or
// GNU `././@LongLink` entries. Nothing touches disk.
//
// What a Scan can't read is skipped and counted, its text never yielded: anything that isn't a regular file (a
// directory, a link, a device), a file over the size limit, a binary one (a NUL in its first 8 KiB), one that isn't
// UTF-8, and a path that could escape the repo (a `..` segment, a leading `/`, a `\`, a drive letter). A symlink or
// hard link, a too-large, binary or non-UTF-8 file, each at a repo path, is yielded as unread, so the Scan leaves the
// Findings in it as they are; a link's target is never read or followed. An archive past
// its compressed or uncompressed limit, or one that's malformed (not gzip, a bad header, cut short), throws
// GitHubUnavailable and isn't read further. No error keeps its source's cause: a lost download's error may name its
// URL, which carries a token.
import { pipeline, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { timedOut } from "../../http-call.ts";
import { GitHubUnavailable } from "./github.ts";
import type { RepoFile, UnreadFile } from "./repo-reader.ts";

const MiB = 1024 * 1024;
const BLOCK = 512;
/** How far into a file a NUL marks it binary, as git looks. */
const BINARY_SNIFF_BYTES = 8 * 1024;

export type ArchiveLimits = {
  /** The most gzipped bytes read; past it the read throws. */
  compressedBytes: number;
  /** The most bytes the gzip may inflate to; past it the read throws. */
  uncompressedBytes: number;
  /** The largest file read; a bigger one is skipped. */
  fileBytes: number;
};

export const ARCHIVE_LIMITS: ArchiveLimits = {
  compressedBytes: 50 * MiB,
  uncompressedBytes: 500 * MiB,
  fileBytes: MiB,
};

/** Why an entry was skipped. */
export type SkipReason = "notAFile" | "tooLarge" | "binary" | "notUtf8" | "badPath";

/** What a read went through: files yielded, entries skipped by reason, and the bytes read. Counts only. */
export type ArchiveCounts = {
  files: number;
  skipped: Record<SkipReason, number>;
  compressedBytes: number;
  uncompressedBytes: number;
};

export const newArchiveCounts = (): ArchiveCounts => ({
  files: 0,
  skipped: { notAFile: 0, tooLarge: 0, binary: 0, notUtf8: 0, badPath: 0 },
  compressedBytes: 0,
  uncompressedBytes: 0,
});

/** The gzipped bytes, counted against the compressed limit; a source that throws is lost, its error dropped. */
async function* compressed(
  source: AsyncIterable<Uint8Array>,
  step: string,
  limits: ArchiveLimits,
  counts: ArchiveCounts,
): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await iterator.next();
    } catch (error) {
      const why = timedOut(error) ? "timed out" : "was lost partway";
      throw new GitHubUnavailable(step, undefined, `${step} ${why}`);
    }
    if (next.done) return;
    counts.compressedBytes += next.value.byteLength;
    if (counts.compressedBytes > limits.compressedBytes) {
      await iterator.return?.();
      throw new GitHubUnavailable(
        step,
        undefined,
        `${step} runs past its ${limits.compressedBytes}-byte compressed limit`,
      );
    }
    yield Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
  }
}

/** The inflated bytes, counted against the uncompressed limit. */
async function* uncompressed(
  source: AsyncIterable<Uint8Array>,
  step: string,
  limits: ArchiveLimits,
  counts: ArchiveCounts,
): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  // A source that throws destroys the gunzip with its error, which the loop below then throws.
  pipeline(Readable.from(compressed(source, step, limits, counts)), gunzip, () => {});
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      counts.uncompressedBytes += chunk.length;
      if (counts.uncompressedBytes > limits.uncompressedBytes) {
        throw new GitHubUnavailable(
          step,
          undefined,
          `${step} runs past its ${limits.uncompressedBytes}-byte uncompressed limit`,
        );
      }
      yield chunk;
    }
  } catch (error) {
    if (error instanceof GitHubUnavailable) throw error;
    // zlib's own error: not gzip, or cut short.
    throw new GitHubUnavailable(step, undefined, `${step} isn't a gzipped tar, or is cut short`);
  }
}

/** Reads exact byte counts from a stream of chunks. */
class Bytes {
  private chunk: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly cutShort: () => Error;
  constructor(source: AsyncIterable<Buffer>, cutShort: () => Error) {
    this.iterator = source[Symbol.asyncIterator]();
    this.cutShort = cutShort;
  }

  /** Fills the current chunk; false at the stream's end. */
  private async fill(): Promise<boolean> {
    while (this.chunk.length === 0) {
      const next = await this.iterator.next();
      if (next.done) return false;
      this.chunk = next.value;
    }
    return true;
  }

  /** The next `length` bytes, or the stream ended short of them. */
  async read(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let left = length;
    while (left > 0) {
      if (!(await this.fill())) throw this.cutShort();
      const part = this.chunk.subarray(0, left);
      this.chunk = this.chunk.subarray(part.length);
      parts.push(part);
      left -= part.length;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Passes over the next `length` bytes without keeping them. */
  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      if (!(await this.fill())) throw this.cutShort();
      const part = Math.min(left, this.chunk.length);
      this.chunk = this.chunk.subarray(part);
      left -= part;
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of `bytes` as strict UTF-8, or undefined when they aren't. */
function decode(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A NUL-terminated header field as text. */
function text(header: Buffer, offset: number, length: number): string | undefined {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decode(end === -1 ? field : field.subarray(0, end));
}

/** A numeric header field: octal digits, or base-256 when its first byte's high bit is set (GNU, for big sizes). */
function number(header: Buffer, offset: number, length: number): number | undefined {
  const field = header.subarray(offset, offset + length);
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const digits = (text(header, offset, length) ?? "").trim();
  return /^[0-7]+$/.test(digits) ? parseInt(digits, 8) : undefined;
}

/** A header's entry: its name (undefined when it isn't UTF-8), size and type flag. */
type Header = { name: string | undefined; size: number; type: string };

/** A ustar header, its checksum checked; undefined when it isn't a valid one. */
function parseHeader(header: Buffer): Header | undefined {
  const checksum = number(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  const size = number(header, 124, 12);
  if (checksum !== sum || size === undefined) return undefined;
  const type = String.fromCharCode(header[156]!);
  // ustar (and POSIX pax) keep a path's start in its prefix field; GNU's magic has none.
  const ustar = header.subarray(257, 263).toString("latin1") === "ustar\0";
  const prefix = ustar ? text(header, 345, 155) : "";
  const name = text(header, 0, 100);
  const whole =
    prefix === undefined || name === undefined
      ? undefined
      : prefix === ""
        ? name
        : `${prefix}/${name}`;
  return { name: whole, size, type };
}

/** A pax extended header's records (`<length> <key>=<value>\n`); undefined when malformed. */
function parsePax(body: Buffer): Map<string, string> | undefined {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString("latin1"));
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) return undefined;
    const record = decode(body.subarray(space + 1, offset + length - 1));
    const equals = record?.indexOf("=") ?? -1;
    if (record === undefined || equals === -1 || body[offset + length - 1] !== 0x0a) {
      return undefined;
    }
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/**
 * The path inside the repo: the archive's path with GitHub's top folder taken off. Undefined for one that could
 * escape the repo or name something odd: a leading `/`, a `\`, a drive letter, an empty, `.` or `..` segment, or no
 * top folder to take off.
 */
function repoPath(archivePath: string): string | undefined {
  if (archivePath.startsWith("/") || archivePath.includes("\\")) return undefined;
  const segments = archivePath.split("/").slice(1);
  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  if (/^[A-Za-z]:/.test(segments[0]!)) return undefined;
  return segments.join("/");
}

/** The bytes a body of `size` takes, padded to whole blocks. */
const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

/** Regular files: "0", the old NUL, and "7" (contiguous, read as regular). */
const REGULAR = new Set(["0", "\0", "7"]);
/** Links: "1" a hard link, "2" a symlink. */
const LINK = new Set(["1", "2"]);

/**
 * The archive's regular files, one at a time: each one's text, or, for one at a repo path whose text it can't read
 * (too large, binary, not UTF-8), that it's unread. A link at a repo path is unread too. `counts` gathers what was
 * read and skipped; `limits` defaults to ARCHIVE_LIMITS. Throws GitHubUnavailable, naming `step`, for an archive past
 * a limit or a malformed one.
 */
export async function* readTarball(
  gzipped: AsyncIterable<Uint8Array>,
  {
    step = "the repo's archive",
    limits: given,
    counts = newArchiveCounts(),
  }: { step?: string; limits?: Partial<ArchiveLimits>; counts?: ArchiveCounts } = {},
): AsyncGenerator<RepoFile | UnreadFile> {
  const limits = { ...ARCHIVE_LIMITS, ...given };
  const malformed = (why: string) => new GitHubUnavailable(step, undefined, `${step} ${why}`);
  const bytes = new Bytes(uncompressed(gzipped, step, limits, counts), () =>
    malformed("is cut short"),
  );
  try {
    // A pax `path` or GNU long name, which names the next entry (its name undefined when it isn't UTF-8).
    let longName: { name: string | undefined } | undefined;
    let paxSize: number | undefined;
    for (;;) {
      const block = await bytes.read(BLOCK);
      if (block.every((byte) => byte === 0)) return;
      const header = parseHeader(block);
      if (header === undefined) throw malformed("has a bad tar header");
      const size = paxSize ?? header.size;
      const name = longName ? longName.name : header.name;
      longName = undefined;
      paxSize = undefined;

      if (header.type === "x" || header.type === "L") {
        // A name or record set longer than any file read is no name a Scan keeps.
        if (size > limits.fileBytes) throw malformed("has a long name past its file limit");
        const body = await bytes.read(size);
        await bytes.skip(padded(size) - size);
        if (header.type === "L") {
          const end = body.indexOf(0);
          longName = { name: decode(end === -1 ? body : body.subarray(0, end)) };
          continue;
        }
        const records = parsePax(body);
        if (records === undefined) throw malformed("has a bad pax header");
        const path = records.get("path");
        if (path !== undefined) longName = { name: path };
        const recordSize = records.get("size");
        if (recordSize !== undefined) {
          if (!/^\d+$/.test(recordSize)) throw malformed("has a bad pax header");
          paxSize = Number(recordSize);
        }
        continue;
      }

      // A pax global header, a GNU long link name: nothing to read, and no entry of their own.
      if (header.type === "g" || header.type === "K") {
        await bytes.skip(padded(size));
        continue;
      }

      const skip = async (reason: SkipReason) => {
        counts.skipped[reason] += 1;
        await bytes.skip(padded(size));
      };
      const path = name === undefined ? undefined : repoPath(name);
      if (!REGULAR.has(header.type)) {
        await skip("notAFile");
        // A link at a path that could escape the repo is skipped like any other entry there.
        if (LINK.has(header.type) && path !== undefined) yield { path, unread: true };
        continue;
      }
      if (path === undefined) {
        await skip("badPath");
        continue;
      }
      if (size > limits.fileBytes) {
        await skip("tooLarge");
        yield { path, unread: true };
        continue;
      }
      const body = await bytes.read(size);
      await bytes.skip(padded(size) - size);
      if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        counts.skipped.binary += 1;
        yield { path, unread: true };
        continue;
      }
      const fileText = decode(body);
      if (fileText === undefined) {
        counts.skipped.notUtf8 += 1;
        yield { path, unread: true };
        continue;
      }
      counts.files += 1;
      yield { path, text: fileText };
    }
  } finally {
    await bytes.close();
  }
}
