// The Scan Job starter on Cloud Run (ADR 0009): runs the Cloud Run Job with an execution whose only override is the
// Scan's id and Team, so the Team's data stays in Cloud SQL. The server's own identity starts it, with an access token
// from the metadata server. It resolves once jobs.run has answered 2xx, logging the operation it names; the execution
// it started isn't waited on. A jobs.run that times out or loses its connection may still have started one, so it
// throws ScanJobStartUnknown, which leaves the Scan queued rather than have the Lead start it again. The Judge run's
// starter makes the same call with the session's id and Team in place of the Scan's (#444).
import { CallFailed, callJson, type Fetch } from "./http-call.ts";
import type { Logger } from "./log.ts";
import {
  SCAN_ID_VARIABLE,
  ScanJobStartUnknown,
  SESSION_ID_VARIABLE,
  TEAM_VARIABLE,
  type JudgeJobStarter,
  type ScanJobStarter,
} from "./scans.ts";

const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** How long each call may take, its answer's body included, before the start fails. */
const CALL_TIMEOUT_MS = 10_000;

/** A Google API refusal's reason, `<status>: <message>` from its JSON body; empty when the body isn't one. */
function refusalReason(body: unknown): string {
  const error =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  if (typeof error !== "object" || error === null) return "";
  const parts = [
    "status" in error ? error.status : undefined,
    "message" in error ? error.message : undefined,
  ].filter((part) => typeof part === "string" && part !== "");
  return parts.length === 0 ? "" : ` (${parts.join(": ")})`;
}

/**
 * Calls `url` as the named step and answers its JSON body. A call that throws (a timeout, a lost connection) throws
 * CallFailed; a non-2xx answer fails with the step's name, the status and Google's reason, never the request's headers.
 */
async function call(
  fetch: Fetch,
  request: { step: string; url: string; init: RequestInit; timeoutMs: number },
): Promise<unknown> {
  const { status, ok, body } = await callJson(fetch, request);
  if (!ok) throw new Error(`${request.step} answered HTTP ${status}${refusalReason(body)}`);
  return body;
}

async function accessToken(fetch: Fetch, timeoutMs: number): Promise<string> {
  const step = "The metadata server's token call";
  const body = await call(fetch, {
    step,
    url: TOKEN_URL,
    init: { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  });
  const token =
    typeof body === "object" && body !== null && "access_token" in body
      ? body.access_token
      : undefined;
  if (typeof token !== "string" || token === "") {
    throw new Error(`${step} answered without an access_token`);
  }
  return token;
}

/** What the starters take: the Job, the logger its start lines go to, and the calls' fetch and timeout. */
type StarterDeps = {
  /** The Job's resource name, `projects/<project>/locations/<region>/jobs/<job>`. */
  job: string;
  logger: Logger;
  fetch?: Fetch;
  timeoutMs?: number;
};

/**
 * Runs the Job with `env` as its execution's only override, as the step named `what`. Resolves with the operation
 * jobs.run answered (read only to log its name), or with `unread` when its 2xx body was lost: the Job started, and only
 * the operation's name is missing. A jobs.run that never answered throws ScanJobStartUnknown.
 */
async function runJob(
  { job, fetch = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }: StarterDeps,
  what: string,
  env: { name: string; value: string }[],
): Promise<{ operation: unknown } | { unread: CallFailed }> {
  const token = await accessToken(fetch, timeoutMs);
  let body: unknown;
  try {
    body = await call(fetch, {
      step: `${what}'s jobs.run (${job})`,
      url: `https://run.googleapis.com/v2/${job}:run`,
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { containerOverrides: [{ env }] } }),
      },
      timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof CallFailed)) throw error;
    // No answer: Google may have started the execution, so the start is unknown.
    if (error.status === undefined) {
      throw new ScanJobStartUnknown(error.message, { cause: error.cause });
    }
    if (error.status < 200 || error.status >= 300) throw error;
    return { unread: error };
  }
  return {
    operation: typeof body === "object" && body !== null && "name" in body ? body.name : undefined,
  };
}

export function cloudRunScanJobStarter(deps: StarterDeps): ScanJobStarter {
  const { logger } = deps;
  return async ({ scanId, team }) => {
    const ran = await runJob(deps, "The Scan Job", [
      { name: SCAN_ID_VARIABLE, value: scanId },
      { name: TEAM_VARIABLE, value: team },
    ]);
    if ("unread" in ran) {
      logger.warn("The Scan Job started, but its operation couldn't be read", {
        scanId,
        team,
        error: ran.unread,
      });
      return;
    }
    logger.info("The Scan Job started", { scanId, team, operation: ran.operation });
  };
}

/**
 * The Judge run's starter (#444): the same Job, with only the session's id and Team as its execution's override. The
 * OpenRouter key is the Job's own, never an override. Its lines hold the Team and the operation, never the session id
 * (threat H7). A failed start throws, and an unknown one throws ScanJobStartUnknown: the hook endpoint logs either, and
 * the sweep picks the session up.
 */
export function cloudRunJudgeJobStarter(deps: StarterDeps): JudgeJobStarter {
  const { logger } = deps;
  return async ({ sessionId, team }) => {
    const ran = await runJob(deps, "The Judge run", [
      { name: SESSION_ID_VARIABLE, value: sessionId },
      { name: TEAM_VARIABLE, value: team },
    ]);
    if ("unread" in ran) {
      logger.warn("The Judge run started, but its operation couldn't be read", {
        team,
        error: ran.unread,
      });
      return;
    }
    logger.info("The Judge run started", { team, operation: ran.operation });
  };
}
