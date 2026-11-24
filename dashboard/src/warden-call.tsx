// A page's call to Warden's server, kept as React state, and the notice for the answers every call shares.
import { useCallback, useEffect, useState } from "react";
import { tryAgainIn } from "./api.ts";

export type WardenCall<T> = {
  result: T | "loading";
  setResult: (update: (old: T | "loading") => T | "loading") => void;
  /** Ask again, keeping the last answer on screen until the new one arrives. */
  refresh: () => void;
  /** Ask again from scratch: the page shows loading until the new answer. */
  retry: () => void;
};

/**
 * Runs `call` on mount, whenever `call` changes (memoize it on what it asks about) and on refresh or retry. A new
 * `call` shows loading at once. An answer that arrives after a newer ask, or after unmount, is dropped: the signal is
 * aborted then, so a call that asks more than once can stop. A session-ended answer calls `onSessionEnded`.
 */
export function useWardenCall<T extends { kind: string }>(
  call: (signal: AbortSignal) => Promise<T>,
  onSessionEnded: () => void,
): WardenCall<T> {
  const [result, setResult] = useState<T | "loading">("loading");
  const [attempt, setAttempt] = useState(0);
  const [askedBy, setAskedBy] = useState(() => call);
  if (askedBy !== call) {
    setAskedBy(() => call);
    setResult("loading");
  }

  useEffect(() => {
    const asking = new AbortController();
    void call(asking.signal).then((answer) => {
      if (asking.signal.aborted) return;
      setResult(answer);
      if (answer.kind === "session-ended") onSessionEnded();
    });
    return () => asking.abort();
  }, [call, onSessionEnded, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const retry = useCallback(() => {
    setResult("loading");
    refresh();
  }, [refresh]);
  return { result, setResult, refresh, retry };
}

/** What a call shows when the server isn't answering (with Retry) or refuses too many sign-in attempts; else nothing. */
export function CallRefused(props: {
  result: { kind: string; retryAfter?: number | null };
  onRetry: () => void;
}) {
  if (props.result.kind === "not-answering") {
    return (
      <>
        <p className="notice" role="alert">
          Warden's server isn't answering
        </p>
        <button type="button" className="primary" onClick={props.onRetry}>
          Retry
        </button>
      </>
    );
  }
  if (props.result.kind === "too-many-attempts") {
    return (
      <p className="notice" role="alert">
        {tryAgainIn(props.result.retryAfter ?? null)}
      </p>
    );
  }
  return null;
}
