// OpenRouter's chat completions API, faked at its HTTP boundary for the Judge's tests: a `fetch` that keeps every
// request it got and answers with what the case gives it. No call leaves the machine.
import type { Fetch } from "../src/http-call.ts";

/** One request the fake got: its URL, headers and parsed JSON body. */
export type FakeCall = { url: string; headers: Headers; body: Record<string, unknown> };

/** A chat completion whose one message holds `content`, or a refusal. */
export const completion = (content: string | null, refusal: string | null = null) => ({
  id: "gen-fake",
  object: "chat.completion",
  model: "anthropic/claude-haiku-5.5",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal } }],
});

/** A completion whose content is the verdict listing `broken`. */
export const verdict = (broken: { rule_id: string; summary: string; event_seqs: number[] }[]) =>
  completion(JSON.stringify({ broken_rules: broken }));

/** `answer` with OpenRouter's `usage` block: its tokens, and its cost in dollars when `cost` is given. */
export const withUsage = (
  answer: object,
  usage: { prompt_tokens: number; completion_tokens: number; cost?: number },
) => ({
  ...answer,
  usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
});

/**
 * The fake: `answer` gives each call's reply, a JSON body (answered 200) or a whole Response; it may also wait on the
 * request's signal, as a call that never answers does.
 */
export function fakeOpenRouter(
  answer: (call: FakeCall, init: RequestInit) => unknown | Promise<unknown>,
): { fetch: Fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    calls.push(call);
    const reply = await answer(call, init);
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return { fetch, calls };
}

/** An answer that never comes: it rejects when the call's signal fires, as fetch does on its timeout. */
export const neverAnswers = (_call: unknown, init: RequestInit) =>
  new Promise<never>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
  });
