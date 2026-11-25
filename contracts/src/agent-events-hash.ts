import { z } from "zod";
import { MaskedAgentEvent } from "./finding.ts";

const RedactedEvents = z.array(MaskedAgentEvent).min(1);

/**
 * The hash of the redacted Agent events a Judge read, kept on its Finding (ADR 0007, threat J8): `sha256:` and the
 * lower-case hex SHA-256 of their canonical form. Each event is compact JSON with its keys in the order `seq`, `at`,
 * `name`, `tool`, `text` (`tool` left out when absent); the events, in the order given, are joined with `\n` and
 * encoded as UTF-8. The input is parsed as `MaskedAgentEvent` values first, so a raw event is refused, never hashed.
 * Web Crypto keeps it usable in the dashboard.
 */
export async function agentEventsHash(events: readonly MaskedAgentEvent[]): Promise<string> {
  const parsed = RedactedEvents.parse(events);
  const canonical = parsed
    .map(({ seq, at, name, tool, text }) =>
      JSON.stringify(tool === undefined ? { seq, at, name, text } : { seq, at, name, tool, text }),
    )
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}
