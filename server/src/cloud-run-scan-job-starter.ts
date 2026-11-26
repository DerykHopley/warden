// The Scan Job starter on Cloud Run (ADR 0009): runs the Cloud Run Job with an execution whose only override is the
// Scan's id and Team, so the Team's data stays in Cloud SQL. The server's own identity starts it, with an access token
// from the metadata server. It resolves once jobs.run has answered 2xx, logging the operation it names; the execution
// it started isn't waited on. A jobs.run that times out or loses its connection may still have started one, so it
// throws ScanJobStartUnknown, which leaves the Scan queued rather than have the Lead start it again.
import { CallFailed, callJson, type Fetch } from "./http-call.ts";
import type { Logger } from "./log.ts";
import {
  SCAN_ID_VARIABLE,
  ScanJobStartUnknown,
  TEAM_VARIABLE,
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
    let body: unknown;
    try {
      body = await call(fetch, {
        step: `The Scan Job's jobs.run (${job})`,
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
      });
    } catch (error) {
      if (!(error instanceof CallFailed)) throw error;
      // No answer: Google may have started the execution, so the start is unknown.
      if (error.status === undefined) {
        throw new ScanJobStartUnknown(error.message, { cause: error.cause });
      }
      if (error.status < 200 || error.status >= 300) throw error;
      // A 2xx whose body was lost: the Job started, and only its operation's name is missing.
      logger.warn("The Scan Job started, but its operation couldn't be read", {
        scanId,
        team,
        error,
      });
      return;
    }
    // The Job started: its answer is the long-running operation, read only to log its name.
    const operation =
      typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
    logger.info("The Scan Job started", { scanId, team, operation });
  };
}
