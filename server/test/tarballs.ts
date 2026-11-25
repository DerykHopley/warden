// Tarballs Guard's tests build, in the shapes `git archive` writes and GitHub serves: ustar headers, a pax global
// header naming the commit, everything under one `<owner>-<repo>-<sha>/` folder, gzipped. Long names come as a pax
// `path` record or a GNU `././@LongLink` entry.
import { gzipSync } from "node:zlib";

const BLOCK = 512;

/** One tar entry: its type flag ("0" a file, "5" a directory, "2" a symlink, "x" pax, "L" a GNU long name, …). */
export type TarEntry = {
  path: string;
  body?: string | Uint8Array;
  type?: string;
  linkname?: string;
  /** ustar's prefix field, which the path is joined to with a `/`. */
  prefix?: string;
};

function field(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`${value} doesn't fit a ${length}-byte field`);
  bytes.copy(header, offset);
}

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";

function header({ path, type = "0", linkname = "", prefix = "" }: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  field(block, 0, 100, path);
  field(block, 100, 8, octal(type === "5" ? 0o755 : 0o644, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(1_700_000_000, 12));
  field(block, 156, 1, type);
  field(block, 157, 100, linkname);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, prefix);
  // The checksum is the header's bytes summed with its own field read as spaces.
  block.fill(" ", 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

/** The entries as an uncompressed tar, ending in its two zero blocks. */
export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    parts.push(
      header(entry, body.length),
      body,
      Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK),
    );
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** A pax extended header's records, each `<length> <key>=<value>\n`, its length counting itself. */
export function paxRecords(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([key, value]) => {
      const rest = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(rest);
      while (String(length).length + Buffer.byteLength(rest) !== length) {
        length = String(length).length + Buffer.byteLength(rest);
      }
      return `${length}${rest}`;
    })
    .join("");
}

/** The folder GitHub puts a repo's files under, as `<owner>-<repo>-<sha>`. */
export const TOP = "example-guarded-1a2b3c4";

/** A file under the top folder, as `git archive` writes a short one. */
export const file = (path: string, body: string | Uint8Array): TarEntry => ({
  path: `${TOP}/${path}`,
  body,
});

/** A link under the top folder: "2" a symlink (the default) or "1" a hard link, pointing at `target`. */
export const link = (path: string, target: string, type: "1" | "2" = "2"): TarEntry => ({
  path: `${TOP}/${path}`,
  type,
  linkname: target,
});

/** A file whose path runs past ustar's 100 bytes, named by a pax `path` record before it. */
export const paxFile = (path: string, body: string): TarEntry[] => [
  { path: "PaxHeaders/long-path", type: "x", body: paxRecords({ path: `${TOP}/${path}` }) },
  { path: `${TOP}/${path}`.slice(0, 99), body },
];

/** A file whose path runs past ustar's 100 bytes, named by a GNU `././@LongLink` entry before it. */
export const gnuLongFile = (path: string, body: string): TarEntry[] => [
  { path: "././@LongLink", type: "L", body: `${TOP}/${path}\0` },
  { path: `${TOP}/${path}`.slice(0, 99), body },
];

/** A gzipped tarball as GitHub serves one: the pax global header, the top folder, then `entries`. */
export function gitHubTarball(entries: TarEntry[]): Buffer {
  return gzipSync(
    tar([
      { path: "pax_global_header", type: "g", body: paxRecords({ comment: "1a2b3c4d5e6f" }) },
      { path: `${TOP}/`, type: "5" },
      ...entries,
    ]),
  );
}

/** A symlink in a repo: its path, and the path it points at. */
export type RepoLink = { path: string; link: string };

/** A repo's entries, each a file `{ path, text }` or a symlink `{ path, link }`, as GitHub's tarball of it. */
export const tarballOf = (entries: ({ path: string; text: string } | RepoLink)[]) =>
  gitHubTarball(
    entries.map((entry) =>
      "link" in entry ? link(entry.path, entry.link) : file(entry.path, entry.text),
    ),
  );

/** `bytes` served in chunks of `size`, as a response body streams them. */
export async function* chunks(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}
