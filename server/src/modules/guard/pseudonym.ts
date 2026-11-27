// A developer's pseudonym (docs/data.md, "The pseudonym"; #100's question 4): the same developer gets the same value
// within a Team and another in every other Team, and someone with the database but not the key can't find it by
// hashing names. One Warden key (`WARDEN_PSEUDONYM_KEY`); each Team's key is derived from it with the Team's id.
import { createHmac } from "node:crypto";

/** The most of the `X-Warden-Developer` header a pseudonym is made from. */
const MAX_DEVELOPER_LENGTH = 256;

/** `HMAC-SHA256(teamKey, developer)` as 64 lower-case hex digits, where `teamKey` is `HMAC-SHA256(key, team)`. */
export function pseudonym(key: Buffer, team: string, developer: string): string {
  const teamKey = createHmac("sha256", key).update(team).digest();
  return createHmac("sha256", teamKey).update(developer).digest("hex");
}

/**
 * The developer an `X-Warden-Developer` header names: its first 256 characters. None for no header, an empty one, or
 * the literal `$USER` (Claude Code sent the variable's name, unfilled).
 */
export function developerOf(header: string | undefined): string | undefined {
  if (header === undefined || header === "" || header === "$USER") return undefined;
  return header.slice(0, MAX_DEVELOPER_LENGTH);
}
