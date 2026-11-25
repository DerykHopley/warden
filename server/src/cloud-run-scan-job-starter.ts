// The Scan Job starter on Cloud Run (ADR 0009): runs the Cloud Run Job with an execution whose only override is the
// Scan's id and Team, so the Team's data stays in Cloud SQL. The server's own identity starts it, with an access token
// from the metadata server. It resolves once jobs.run has answered 2xx, logging the operation it names; the execution
// it started isn't waited on. A jobs.run that times out or loses its connection may still have started one, so it
// throws ScanJobStartUnknown, which leaves the Scan queued rather than have the Lead start it again.
import type { Logger } from "./log.ts";
import {
  SCAN_ID_VARIABLE,
  ScanJobStartUnknown,
  TEAM_VARIABLE,
  type ScanJobStarter,
} from "./scans.ts";

/** The part of `fetch` the starter calls, so a test can hand it a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** How long each call may take, its answer's body included, before the start fails. */
const CALL_TIMEOUT_MS = 10_000;

/** Whether `error` is the call's signal firing: its timeout, or an abort. */
const timedOut = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** The step's error for a call or a body read that threw: timed out, or fetch's own message. */
function callError(step: string, error: unknown, timeoutMs: number): string {
  return timedOut(error)
    ? `${step} timed out after ${timeoutMs} ms`
    : `${step} failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** A Google API refusal's reason, `<status>: <message>` from its JSON body; empty when the body isn't one. */
async function refusalReason(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
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
 * Calls `url` as the named step. A call that throws (a timeout, a lost connection) is thrown as `unanswered` makes it;
 * a non-2xx answer fails with the step's name, the status and Google's reason, never the request's headers.
 */
async function call(
  fetch: Fetch,
  {
    step,
    url,
    init,
    timeoutMs,
    unanswered = Error,
  }: {
    step: string;
    url: string;
    init: RequestInit;
    timeoutMs: number;
    unanswered?: new (message: string, options: ErrorOptions) => Error;
  },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // fetch's own error: it names the failure, never the request's headers.
    throw new unanswered(callError(step, error, timeoutMs), { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${step} answered HTTP ${response.status}${await refusalReason(response)}`);
  }
  return response;
}

async function accessToken(fetch: Fetch, timeoutMs: number): Promise<string> {
  const step = "The metadata server's token call";
  const response = await call(fetch, {
    step,
    url: TOKEN_URL,
    init: { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A body that never arrived is a timeout; one that isn't JSON has no access_token, below.
    if (timedOut(error)) throw new Error(callError(step, error, timeoutMs), { cause: error });
  }
  const token =
    typeof body === "object" && body !== null && "access_token" in body
      ? body.access_token
      : undefined;
  if (typeof token !== "string" || token === "") {
    throw new Error(`${step} answered HTTP ${response.status} without an access_token`);
  }
  return token;
}

export function cloudRunScanJobStarter({
  job,
  logger,
  fetch = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS,
}: {
  /** The Job's resource name, `projects/<project>/locations/<region>/jobs/<job>`. */
  job: string;
  logger: Logger;
  fetch?: Fetch;
  timeoutMs?: number;
}): ScanJobStarter {
  return async ({ scanId, team }) => {
    const token = await accessToken(fetch, timeoutMs);
    const step = `The Scan Job's jobs.run (${job})`;
    const response = await call(fetch, {
      step,
      url: `https://run.googleapis.com/v2/${job}:run`,
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: SCAN_ID_VARIABLE, value: scanId },
                  { name: TEAM_VARIABLE, value: team },
                ],
              },
            ],
          },
        }),
      },
      timeoutMs,
      unanswered: ScanJobStartUnknown,
    });
    // The Job started: its answer is the long-running operation, read only to log its name.
    try {
      const body: unknown = await response.json();
      const operation =
        typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
      logger.info("The Scan Job started", { scanId, team, operation });
    } catch (error) {
      logger.warn("The Scan Job started, but its operation couldn't be read", {
        scanId,
        team,
        error: new Error(callError(step, error, timeoutMs), { cause: error }),
      });
    }
  };
}
