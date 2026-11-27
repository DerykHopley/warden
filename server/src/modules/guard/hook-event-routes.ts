// The hook endpoint (spec #225, slice 1, #183): `POST /api/hook/events` takes each event Claude Code's managed hook
// posts, with the Team's hook token, and stores what the Team's Privacy tier keeps of it, redacted (#184), under the
// developer's pseudonym. Mounted by the app through `moduleRoutes` (ADR 0005), with no session sign-in: the hook token is the only
// credential, and the Team comes from it alone, never from the body or another header (story 15, threat H2).
// Nothing here logs (threat H7): the app's request line is the only line, and it holds no body, token or developer.
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, MountRoutes } from "../../app.ts";
import { createAttemptLimit } from "../../attempt-limit.ts";
import { setNewest } from "../../capped-map.ts";
import { refusedBody } from "../../refused-body.ts";
import { clientAddress, createSignInLimit } from "../../sign-in-limit.ts";
import type { AgentSessions } from "./agent-sessions.ts";
import type { HookSettings } from "./hook-settings.ts";
import { HOOK_EVENTS, HOOK_EVENTS_PATH } from "./managed-settings.ts";
import { developerOf, pseudonym } from "./pseudonym.ts";
import { redactEvent } from "./redact-event.ts";
import { filterToTier } from "./tier-filter.ts";

/** Refused hook tokens an address may send in a minute; the next is held back for the rest of it (threat H1). */
export const HOOK_REFUSALS_PER_MINUTE = 20;

/** Events a Team may send in a minute, counted per server instance; the next is refused (threat H6). */
export const HOOK_EVENTS_PER_MINUTE = 600;

/** The largest body read; a longer one answers 413 (threat H6). */
export const HOOK_BODY_LIMIT_BYTES = 1024 * 1024;

const MINUTE_MS = 60_000;

/** The most sessions whose refused events are kept in memory; past it, the oldest is forgotten. */
const MAX_REFUSED_SESSIONS = 10_000;

/** The events the managed-settings block sends at any tier: the only ones stored. */
const STORED_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);

/** What the endpoint reads of an event before the tier filter: its session and its name. */
const EventShape = z.object({
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "isn't 1 to 128 of A-Z, a-z, 0-9, _ and -"),
  hook_event_name: z.string(),
});

/** A body that couldn't be read whole within the limit. */
const TOO_LARGE = Symbol("too large");

/** The request's body as text, reading no more than the limit; `TOO_LARGE` past it, whatever Content-Length says. */
async function boundedBody(c: Context<AppEnv>): Promise<string | typeof TOO_LARGE> {
  const declared = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declared) && declared > HOOK_BODY_LIMIT_BYTES) return TOO_LARGE;
  const stream = c.req.raw.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > HOOK_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body as a JSON object, or undefined when it isn't one. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Each session's events refused for its Team's limit since its last stored one, in this instance's memory, so a flood
 * of refusals writes nothing to the database. Kept in the order sessions were first counted, so the first is oldest.
 */
function createRefusedCounts() {
  const counts = new Map<string, number>();
  const keyOf = (team: string, session: string) => `${team}\u0000${session}`;
  return {
    /** Counts `n` refusals on the session. */
    add(team: string, session: string, n = 1) {
      const key = keyOf(team, session);
      const count = counts.get(key);
      if (count !== undefined) counts.set(key, count + n);
      else setNewest(counts, key, n, MAX_REFUSED_SESSIONS);
    },
    /** The session's refusals, forgotten here: the caller stores them, or adds them back when it can't. */
    take(team: string, session: string): number {
      const key = keyOf(team, session);
      const count = counts.get(key) ?? 0;
      counts.delete(key);
      return count;
    },
  };
}

const error = (c: Context<AppEnv>, message: string, status: 400 | 401 | 413 | 429 | 503) =>
  c.json({ error: message }, status);

export function hookEventRoutes({
  hookSettings,
  agentSessions,
  pseudonymKey,
  behindCloudRun,
  now = Date.now,
}: {
  hookSettings: HookSettings;
  agentSessions: AgentSessions;
  /** The Warden pseudonym key (`WARDEN_PSEUDONYM_KEY`); without it the endpoint answers 503. */
  pseudonymKey?: Buffer;
  behindCloudRun: boolean;
  /** The limits' clock, in milliseconds: a test moves it. */
  now?: () => number;
}): MountRoutes {
  // Each kept in this instance's memory: each Cloud Run instance counts on its own (as threat A5 accepts for sign-in).
  // Refused hook tokens are counted as `signIn` counts failed session tokens, with a count of their own.
  const refusedTokens = createSignInLimit({
    max: HOOK_REFUSALS_PER_MINUTE,
    windowMs: MINUTE_MS,
    now,
  });
  const teamEvents = createAttemptLimit({ max: HOOK_EVENTS_PER_MINUTE, windowMs: MINUTE_MS, now });
  const refused = createRefusedCounts();

  /** The Team the request's hook token names, or the answer that refuses it: 429 held back, 401 for a bad token. */
  async function teamOf(c: Context<AppEnv>): Promise<string | Response> {
    const address = clientAddress(
      {
        forwardedFor: c.req.header("X-Forwarded-For"),
        socketAddress: c.env?.incoming?.socket.remoteAddress,
      },
      behindCloudRun,
    );
    // Held back, the token reaches no database. Only the Authorization header, never a query string.
    const checked = await refusedTokens.check(address, c.req.header("Authorization"), (token) =>
      hookSettings.teamFor(token),
    );
    if ("heldFor" in checked) {
      c.header("Retry-After", String(checked.heldFor));
      return error(c, "Too many refused hook tokens", 429);
    }
    if ("refused" in checked) return error(c, "Not a valid hook token", 401);
    return checked.found;
  }

  return (app) => {
    app.post(HOOK_EVENTS_PATH, async (c) => {
      const team = await teamOf(c);
      if (team instanceof Response) return team;

      const retryAfter = teamEvents.attempt(team);
      if (retryAfter !== undefined) {
        // Counted on its session when, read within the size limit, it's an event that would have been stored.
        const body = await boundedBody(c);
        const shape = EventShape.safeParse(body === TOO_LARGE ? undefined : jsonObject(body));
        if (shape.success && STORED_EVENTS.has(shape.data.hook_event_name)) {
          refused.add(team, shape.data.session_id);
        }
        c.header("Retry-After", String(retryAfter));
        return error(c, "Too many hook events", 429);
      }

      const body = await boundedBody(c);
      if (body === TOO_LARGE) return error(c, "The event is over 1 MiB", 413);
      if (pseudonymKey === undefined) return error(c, "The hook isn't set up here", 503);

      const event = jsonObject(body);
      if (event === undefined) return error(c, "The body isn't a JSON object", 400);
      const shape = EventShape.safeParse(event);
      if (!shape.success) return error(c, refusedBody(shape.error), 400);
      const { session_id: sessionId, hook_event_name: name } = shape.data;
      if (!STORED_EVENTS.has(name)) return c.body(null, 204);

      const { privacyTier } = await hookSettings.read(team);
      const fields = redactEvent(filterToTier(event, privacyTier));
      const developer = developerOf(c.req.header("X-Warden-Developer"));
      const refusedEvents = refused.take(team, sessionId);
      try {
        await agentSessions.store(team, {
          sessionId,
          name,
          tool: typeof fields.tool_name === "string" ? fields.tool_name : null,
          fields,
          developer: developer === undefined ? null : pseudonym(pseudonymKey, team, developer),
          ended: name === "SessionEnd",
          refusedEvents,
        });
      } catch (thrown) {
        // Not stored, so the refusals wait for the session's next event.
        if (refusedEvents > 0) refused.add(team, sessionId, refusedEvents);
        throw thrown;
      }
      return c.body(null, 204);
    });
  };
}
