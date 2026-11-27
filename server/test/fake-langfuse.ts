// Langfuse's OpenTelemetry trace endpoint, faked at its HTTP boundary for the tracer's and the Judge's tests: a `fetch`
// that keeps every request it got, its body read back into spans with plain attributes, and answers with what the case
// gives it (204 by default). No call leaves the machine.
import type { Fetch } from "../src/http-call.ts";

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number };

/** One span of a request, its attributes as a plain record. */
export type FakeSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
};

/** One request the fake got: its URL, headers, raw body text, and the spans it held. */
export type FakeTraceCall = { url: string; headers: Headers; text: string; spans: FakeSpan[] };

type OtlpSpan = Omit<FakeSpan, "attributes"> & {
  attributes?: { key: string; value: AnyValue }[];
};
type OtlpBody = { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };

const plain = (value: AnyValue): string | number =>
  value.stringValue ?? value.doubleValue ?? Number(value.intValue);

/** The spans an OTLP/HTTP JSON body holds, each attribute's value unwrapped. */
export function spansOf(text: string): FakeSpan[] {
  const body = JSON.parse(text) as OtlpBody;
  return body.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({
        ...span,
        attributes: Object.fromEntries(
          (span.attributes ?? []).map(({ key, value }) => [key, plain(value)]),
        ),
      })),
    ),
  );
}

/** A request's root span (the trace) and its generations, in the order they were sent. */
export function traceOf(call: FakeTraceCall): { root: FakeSpan; generations: FakeSpan[] } {
  const root = call.spans.find((span) => span.parentSpanId === undefined);
  if (root === undefined) throw new Error("the trace has no root span");
  return { root, generations: call.spans.filter((span) => span.parentSpanId === root.spanId) };
}

/** The fake: `answer` gives each request's reply, a whole Response, or waits on the request's signal. */
export function fakeLangfuse(
  answer: (call: FakeTraceCall, init: RequestInit) => Response | Promise<Response> = () =>
    new Response(null, { status: 200 }),
): { fetch: Fetch; calls: FakeTraceCall[] } {
  const calls: FakeTraceCall[] = [];
  const fetch: Fetch = async (url, init) => {
    const text = String(init.body);
    const call = { url, headers: new Headers(init.headers), text, spans: spansOf(text) };
    calls.push(call);
    return answer(call, init);
  };
  return { fetch, calls };
}
