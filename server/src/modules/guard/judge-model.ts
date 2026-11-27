// The Judge's model call (spec #225, slice 5a): one request to an OpenAI-compatible chat completions API, built from a
// base URL, a key, a model name and extra body fields, so the Judge doesn't change when it points at another URL
// (slice 6). OpenRouter's call adds its `provider` routing as one of those fields; a Team's own model (`localModel`)
// sends no key and no routing, through the pinned connection. A call that times out, loses its connection, answers
// non-2xx or doesn't answer a chat completion throws, naming only its status: never the key, the prompt or the answer.
// Slice 7a: each model says whether it is paid (OpenRouter's is), and an answer carries its usage block's tokens and
// cost, for the spending ledger.
import { z } from "zod";
import { ConfigError } from "../../config.ts";
import { CallFailed, callJson, timedOut, type Fetch } from "../../http-call.ts";
import { AddressRefused, type UrlRule } from "./judge-url.ts";
import { AnswerTooLarge, pinnedFetch } from "./pinned-fetch.ts";

/** OpenRouter's OpenAI-compatible API. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter's routing for the Judge: only providers that keep no data (ZDR) and don't collect it, and only those that
 * honour every parameter sent, so the JSON-schema `response_format` is never dropped.
 */
export const OPENROUTER_PROVIDER = {
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
} as const;

/** How long the model call, and its answer's body, may take. */
export const JUDGE_CALL_TIMEOUT_MS = 60_000;

export type ChatMessage = { role: "system" | "user"; content: string };

/**
 * What an answer's usage block stated (slice 7a): its input and output tokens and its cost in US dollars, each left out
 * when the block doesn't state it as a count or a cost at or above 0.
 */
export type ModelUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number };

/**
 * The model's answer: its content, or a refusal (its `refusal` set, or no content); with `usage` when it had a usage
 * block, as OpenRouter's always does.
 */
export type ModelAnswer = ({ refusal: true } | { refusal: false; content: string }) & {
  usage?: ModelUsage;
};

/** What the Judge calls: one completion of `messages`, answering to the JSON schema `schema` names. */
export interface JudgeModel {
  /** The model's name, as each call sends it. */
  readonly model: string;
  /** Whether a call costs Warden money (OpenRouter's), so the Team's spending limit and ledger apply to it. */
  readonly paid: boolean;
  complete(
    messages: ChatMessage[],
    schema: { name: string; schema: Record<string, unknown> },
  ): Promise<ModelAnswer>;
}

/**
 * The model call failed: the Judge leaves the session as it was. `retry`: whether the same call might answer next time
 * (a timeout, a lost connection, an answer that isn't a chat completion, a 429 or a 5xx). `billed`: whether the
 * provider may have charged for it, so its reserved cost stands (all but a non-2xx answer under 500 other than 408:
 * those refuse the call before it runs).
 */
export class ModelCallFailed extends Error {
  override name = "ModelCallFailed";
  readonly retry: boolean;
  readonly billed: boolean;
  constructor(
    message: string,
    { retry = true, billed = true }: { retry?: boolean; billed?: boolean } = {},
  ) {
    super(message);
    this.retry = retry;
    this.billed = billed;
  }
}

/** A non-2xx answer: a 429 or a 5xx may answer next time; a 5xx or a 408 may have run, and been billed. */
const answeredStatus = (status: number) =>
  new ModelCallFailed(`the Judge's model call answered ${status}`, {
    retry: status === 429 || status >= 500,
    billed: status === 408 || status >= 500,
  });

/** The part of a chat completion the Judge reads. */
const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
});

/** A whole count at or above 0, else nothing. */
const count = z.number().int().nonnegative().optional().catch(undefined);
/** A finite amount at or above 0, else nothing. */
const amount = z.number().nonnegative().finite().optional().catch(undefined);

/** A usage block, each field kept only when it is what OpenRouter states: a bad field never fails the answer. */
const Usage = z
  .object({ prompt_tokens: count, completion_tokens: count, cost: amount })
  .optional()
  .catch(undefined);

/** What `usage` states, or nothing when the answer had no usage block. */
function readUsage(usage: unknown): ModelUsage | undefined {
  const parsed = Usage.parse(usage);
  if (parsed === undefined) return undefined;
  return {
    ...(parsed.prompt_tokens === undefined ? {} : { inputTokens: parsed.prompt_tokens }),
    ...(parsed.completion_tokens === undefined ? {} : { outputTokens: parsed.completion_tokens }),
    ...(parsed.cost === undefined ? {} : { costUsd: parsed.cost }),
  };
}

/**
 * Why a call failed, without the URL, the prompt or the answer: the pinned connection's reason, the timeout, an
 * answer over the cap, or the connection error's code (ECONNREFUSED and the like).
 */
function callFailure(error: CallFailed): string {
  const cause = error.cause;
  if (cause instanceof AddressRefused)
    return `the Judge's model call was refused: ${cause.message}`;
  if (cause instanceof AnswerTooLarge) return `the Judge's model call failed: ${cause.message}`;
  if (timedOut(cause)) return error.message;
  const code = (cause as { code?: unknown } | undefined)?.code;
  const named = typeof code === "string" ? code : cause instanceof Error ? cause.name : "an error";
  return `the Judge's model call failed: ${named}`;
}

/**
 * A model behind an OpenAI-compatible `POST <baseUrl>/chat/completions`, with `apiKey` as the Bearer token (no
 * Authorization header without one) and `extraBody` added to each request's body. With `jsonModeFallback`, a 400 to
 * the JSON-schema request is followed by one more request in JSON mode (`{ type: "json_object" }`), for a server that
 * doesn't take a schema; the verdict is checked against the schema either way. `fetch` is a test's fake. A call that
 * times out or loses its connection throws ModelCallFailed naming the reason (`callFailure`), as a non-2xx answer does.
 */
export function chatCompletionsModel({
  baseUrl,
  apiKey,
  model,
  extraBody = {},
  jsonModeFallback = false,
  fetch = globalThis.fetch,
  timeoutMs = JUDGE_CALL_TIMEOUT_MS,
}: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  extraBody?: Record<string, unknown>;
  jsonModeFallback?: boolean;
  fetch?: Fetch;
  timeoutMs?: number;
}): JudgeModel {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
  const call = (messages: ChatMessage[], responseFormat: Record<string, unknown>) =>
    callJson(fetch, {
      step: "the Judge's model call",
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, response_format: responseFormat, ...extraBody }),
      },
      timeoutMs,
    });
  const answerTo = async (
    messages: ChatMessage[],
    { name, schema }: Parameters<JudgeModel["complete"]>[1],
  ) => {
    try {
      const answer = await call(messages, {
        type: "json_schema",
        json_schema: { name, strict: true, schema },
      });
      if (jsonModeFallback && answer.status === 400) {
        return await call(messages, { type: "json_object" });
      }
      return answer;
    } catch (error) {
      if (error instanceof CallFailed) throw new ModelCallFailed(callFailure(error));
      throw error;
    }
  };
  return {
    model,
    paid: false,
    async complete(messages, schema) {
      const answer = await answerTo(messages, schema);
      if (!answer.ok) throw answeredStatus(answer.status);
      const completion = Completion.safeParse(answer.body);
      if (!completion.success) {
        throw new ModelCallFailed("the Judge's model call answered no chat completion");
      }
      const { content, refusal } = completion.data.choices[0]!.message;
      const usage = readUsage(completion.data.usage);
      const stated = usage === undefined ? {} : { usage };
      if (refusal || !content?.trim()) return { refusal: true, ...stated };
      return { refusal: false, content, ...stated };
    },
  };
}

/**
 * The Judge's model for a run's settings: on OpenRouter with `apiKey`. With none it throws ConfigError naming
 * OPENROUTER_API_KEY, and as a run asks for its model only once it has a session to judge, a run with nothing to judge
 * still exits 0 without the key, and one with a session stops before it reserves anything in the ledger (#489).
 */
export function judgeModel({
  apiKey,
  ...options
}: {
  apiKey: string | undefined;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): JudgeModel {
  if (apiKey === undefined) throw new ConfigError(["OPENROUTER_API_KEY"]);
  return openRouterModel({ apiKey, ...options });
}

/**
 * A Team's own model (spec #225, slice 6a, story 10): its OpenAI-compatible URL and model name, through the pinned
 * connection (`pinnedFetch`), with no key and no OpenRouter routing, and the JSON-mode fallback. A call the connection
 * refuses, or that fails, throws ModelCallFailed naming the reason, never the URL.
 */
export function localModel({
  url,
  model,
  timeoutMs,
  ...rule
}: {
  url: string;
  model: string;
  timeoutMs?: number;
} & UrlRule): JudgeModel {
  return chatCompletionsModel({
    baseUrl: url,
    model,
    jsonModeFallback: true,
    fetch: pinnedFetch(rule),
    timeoutMs,
  });
}

/**
 * The Judge's model on OpenRouter, with its routing (`OPENROUTER_PROVIDER`): paid, its usage block read from every
 * answer (OpenRouter always sends one; no request field asks for it).
 */
export function openRouterModel(options: {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): JudgeModel {
  const inner = chatCompletionsModel({
    ...options,
    baseUrl: OPENROUTER_BASE_URL,
    extraBody: { provider: OPENROUTER_PROVIDER },
  });
  return { ...inner, paid: true };
}
