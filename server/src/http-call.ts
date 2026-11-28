// One call to an outside service's JSON API, as the Scan Job starter and the GitHub client make it: one timeout covers
// the answer and its body, and the body is read whole before it's parsed, so a body lost mid-stream (a timeout, a
// connection reset) is told apart from one that isn't JSON. A call that throws names its step and what went wrong,
// never the request's headers or body, where the tokens and secrets are.

/** The part of `fetch` a client calls, so a test can hand it a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** An answer: its status, whether it was 2xx, and its JSON body (undefined when it isn't JSON). */
export type Answer = { status: number; ok: boolean; body: unknown };

/** Whether `error` is the call's signal firing: its timeout, or an abort. */
export const timedOut = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/**
 * Why a call threw, as a code safe to log: `timeout` for a timeout, else the first string `code` on the error or its
 * causes (fetch puts a refused connection's ECONNREFUSED on its cause), else undefined.
 */
export function failureCode(error: unknown): string | undefined {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (timedOut(at)) return "timeout";
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * A call, or its body's read, that threw: it timed out, or its connection was lost. `status` is the answer's when one
 * came before its body was lost, undefined when none came. Its cause is fetch's own error.
 */
export class CallFailed extends Error {
  override name = "CallFailed";
  readonly step: string;
  readonly status: number | undefined;
  constructor(step: string, status: number | undefined, error: unknown, timeoutMs: number) {
    super(
      timedOut(error)
        ? `${step} timed out after ${timeoutMs} ms`
        : `${step} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    this.step = step;
    this.status = status;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Calls `url` as the named step and reads its JSON body, both within `timeoutMs`; throws CallFailed if either throws. */
export async function callJson(
  fetch: Fetch,
  {
    step,
    url,
    init,
    timeoutMs,
  }: { step: string; url: string; init: RequestInit; timeoutMs: number },
): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CallFailed(step, undefined, error, timeoutMs);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new CallFailed(step, response.status, error, timeoutMs);
  }
  return { status: response.status, ok: response.ok, body: parseJson(text) };
}
