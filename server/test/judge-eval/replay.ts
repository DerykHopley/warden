// The demo's live attack (spec #225, slice 10c): `WARDEN_REPLAY_URL=<warden> WARDEN_HOOK_TOKEN=<token> pnpm --filter
// @warden/server eval:replay` posts the eval case marked `replay` to that Warden's hook endpoint, event by event, as
// the managed-settings block sends it at the case's tier, under a session of its own and the developer `demo`. That
// Warden then judges the session like any other, when its Judge starter is set.
//
// It checks both variables before any post (exit 2), and stops at the first answer that isn't 204, or a connection
// error (exit 1). Nothing it prints holds the token or an event's body, where the case's fixture secret is.
import { randomUUID } from "node:crypto";
import { failureCode } from "../../src/http-call.ts";
import { HOOK_EVENTS_PATH } from "../../src/modules/guard/managed-settings.ts";
import { isMain } from "./cli.ts";
import { loadEvalCases } from "./eval-cases.ts";
import { hookEventsSentAt } from "./harness.ts";

/** The developer the replayed events name. */
const DEVELOPER = "demo";

/** How long one post may take. */
const POST_TIMEOUT_MS = 30_000;

/** The hosts an `http` URL may name: a Warden on this machine. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** Thrown at a variable that's unset or wrong: its message names the variable, never its value. */
class SettingRefused extends Error {}

/** The hook endpoint's URL and the token, from `env`; throws SettingRefused at the first problem. */
function readSettings(env: Record<string, string | undefined>): { hookUrl: string; token: string } {
  const given = env.WARDEN_REPLAY_URL;
  if (!given) throw new SettingRefused("set WARDEN_REPLAY_URL to the Warden the replay posts to");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new SettingRefused("WARDEN_REPLAY_URL isn't a URL");
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local)
    throw new SettingRefused(
      "WARDEN_REPLAY_URL must be https (http only for localhost or 127.0.0.1)",
    );
  const token = env.WARDEN_HOOK_TOKEN;
  if (!token) throw new SettingRefused("set WARDEN_HOOK_TOKEN to the Team's hook token");
  return { hookUrl: new URL(HOOK_EVENTS_PATH, url).href, token };
}

async function main(): Promise<number> {
  let settings;
  try {
    settings = readSettings(process.env);
  } catch (error) {
    if (!(error instanceof SettingRefused)) throw error;
    console.error(error.message);
    return 2;
  }
  const replays = loadEvalCases().filter((c) => c.replay);
  if (replays.length !== 1) {
    console.error(`the eval set marks ${replays.length} cases replay, not one`);
    return 2;
  }
  const [replay] = replays as [(typeof replays)[number]];
  const sent = hookEventsSentAt(replay.tier);
  const sessionId = `replay-${randomUUID()}`;
  console.log(`session ${sessionId}`);

  let posted = 0;
  for (const [i, event] of replay.events.entries()) {
    if (!sent.has(event.hook_event_name)) continue;
    const at = `event ${i} (${event.hook_event_name})`;
    let response: Response;
    try {
      response = await fetch(settings.hookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.token}`,
          "X-Warden-Developer": DEVELOPER,
        },
        body: JSON.stringify({ session_id: sessionId, ...event }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      await response.arrayBuffer();
    } catch (error) {
      console.error(`${at} failed: ${failureCode(error) ?? "an error"}`);
      return 1;
    }
    if (response.status !== 204) {
      console.error(`${at} answered ${response.status}, not 204`);
      return 1;
    }
    posted += 1;
  }
  console.log(`posted ${posted} events`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main();
