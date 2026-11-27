// The Judge's model call (spec #225, slice 5a): one request to an OpenAI-compatible chat completions API, built from a
// base URL, a key, a model name and extra body fields, so the Judge doesn't change when it points at another URL
// (slice 6). OpenRouter's call adds its `provider` routing as one of those fields; a Team's own model (`localModel`)
// sends no key and no routing, through the pinned connection. A call that times out, loses its connection, answers
// non-2xx or doesn't answer a chat completion throws, naming only its status: never the key, the prompt or the answer.
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

/** The model's answer: its content, or a refusal (its `refusal` set, or no content). */
export type ModelAnswer = { refusal: true } | { refusal: false; content: string };

/** What the Judge calls: one completion of `messages`, answering to the JSON schema `schema` names. */
export interface JudgeModel {
  complete(
    messages: ChatMessage[],
    schema: { name: string; schema: Record<string, unknown> },
  ): Promise<ModelAnswer>;
}

/** The model call failed: the Judge leaves the session as it was, for a retry. */
export class ModelCallFailed extends Error {
  override name = "ModelCallFailed";
}

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
});

/**
 * A model behind an OpenAI-compatible `POST <baseUrl>/chat/completions`, with `apiKey` as the Bearer token (no
 * Authorization header without one) and `extraBody` added to each request's body. With `jsonModeFallback`, a 400 to
 * the JSON-schema request is followed by one more request in JSON mode (`{ type: "json_object" }`), for a server that
 * doesn't take a schema; the verdict is checked against the schema either way. `fetch` is a test's fake.
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
  return {
    async complete(messages, { name, schema }) {
      let answer = await call(messages, {
        type: "json_schema",
        json_schema: { name, strict: true, schema },
      });
      if (jsonModeFallback && answer.status === 400) {
        answer = await call(messages, { type: "json_object" });
      }
      if (!answer.ok) {
        throw new ModelCallFailed(`the Judge's model call answered ${answer.status}`);
      }
      const completion = Completion.safeParse(answer.body);
      if (!completion.success) {
        throw new ModelCallFailed("the Judge's model call answered no chat completion");
      }
      const { content, refusal } = completion.data.choices[0]!.message;
      if (refusal || !content?.trim()) return { refusal: true };
      return { refusal: false, content };
    },
  };
}

/**
 * The Judge's model for a run's settings: on OpenRouter with `apiKey`, or, with none, a model whose every call
 * rejects with ConfigError naming OPENROUTER_API_KEY before anything is sent, so a run with nothing to judge still
 * exits 0 without the key.
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
  if (apiKey === undefined) {
    return { complete: () => Promise.reject(new ConfigError(["OPENROUTER_API_KEY"])) };
  }
  return openRouterModel({ apiKey, ...options });
}

/**
 * Why a local call failed, without the URL, the prompt or the answer: the pinned connection's reason, the timeout, an
 * answer over the cap, or the connection error's code (ECONNREFUSED and the like).
 */
function localFailure(error: CallFailed): string {
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
  const inner = chatCompletionsModel({
    baseUrl: url,
    model,
    jsonModeFallback: true,
    fetch: pinnedFetch(rule),
    timeoutMs,
  });
  return {
    async complete(messages, schema) {
      try {
        return await inner.complete(messages, schema);
      } catch (error) {
        if (error instanceof CallFailed) throw new ModelCallFailed(localFailure(error));
        throw error;
      }
    },
  };
}

/** The Judge's model on OpenRouter, with its routing (`OPENROUTER_PROVIDER`). */
export function openRouterModel(options: {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): JudgeModel {
  return chatCompletionsModel({
    ...options,
    baseUrl: OPENROUTER_BASE_URL,
    extraBody: { provider: OPENROUTER_PROVIDER },
  });
}
