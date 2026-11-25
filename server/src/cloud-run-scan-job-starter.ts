// The Scan Job starter on Cloud Run (ADR 0009): runs the Cloud Run Job with an execution whose only override is the
// Scan's id and Team, so the Team's data stays in Cloud SQL. The server's own identity starts it, with an access token
// from the metadata server. It resolves once jobs.run has answered; the execution it started isn't waited on.
import type { ScanJobStarter } from "./scans.ts";

/** The part of `fetch` the starter calls, so a test can hand it a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** How long each call may take before the start fails. */
const CALL_TIMEOUT_MS = 10_000;

/** Calls `url` as the named step, failing with the step's name and the status, and nothing from the call itself. */
async function call(
  fetch: Fetch,
  step: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(
      timedOut
        ? `${step} timed out after ${timeoutMs} ms`
        : `${step} failed: ${error instanceof Error ? error.message : String(error)}`,
      // fetch's own error: it names the failure, never the request's headers.
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`${step} answered HTTP ${response.status}`);
  return response;
}

async function accessToken(fetch: Fetch, timeoutMs: number): Promise<string> {
  const step = "The metadata server's token call";
  const response = await call(
    fetch,
    step,
    TOKEN_URL,
    { headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  );
  const body: unknown = await response.json().catch(() => undefined);
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
  fetch = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS,
}: {
  /** The Job's resource name, `projects/<project>/locations/<region>/jobs/<job>`. */
  job: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): ScanJobStarter {
  return async ({ scanId, team }) => {
    const token = await accessToken(fetch, timeoutMs);
    await call(
      fetch,
      `The Scan Job's jobs.run (${job})`,
      `https://run.googleapis.com/v2/${job}:run`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: "WARDEN_SCAN_ID", value: scanId },
                  { name: "WARDEN_TEAM", value: team },
                ],
              },
            ],
          },
        }),
      },
      timeoutMs,
    );
  };
}
