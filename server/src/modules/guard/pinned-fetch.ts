// The connection to a Team's own Judge model (spec #225, slice 6a), pinned to the address it checked. `pinnedFetch`
// answers a `Fetch` that makes its request with `node:http` or `node:https`: it checks the URL's scheme and host with
// the URL rule (`checkTarget`) at each call, and when any address the host resolves to is refused, it fails with the
// reason and no connection opens; otherwise the request's own `lookup` answers only the addresses just checked, so a
// DNS change between a check and the connect can't slip through. It never follows a redirect: a 3xx is answered as it
// is. An answer's body is read once, as it streams, and only up to `MAX_ANSWER_BYTES`.
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Fetch } from "../../http-call.ts";
import { AddressRefused, checkTarget, type ResolvedAddress, type UrlRule } from "./judge-url.ts";

/** Statuses whose answer has no body, which `Response` refuses one for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** The most an answer's body may hold: a verdict is a few kilobytes. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/** An answer's body passed `MAX_ANSWER_BYTES`: its read fails and the connection closes. */
export class AnswerTooLarge extends Error {
  override name = "AnswerTooLarge";
  constructor() {
    super("its answer is over 1 MiB");
  }
}

/** A lookup that answers only `checked`, the addresses the URL rule just accepted, whatever the host. */
function pinnedLookup(checked: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : undefined;
    const usable = checked.filter((answer) => family === undefined || answer.family === family);
    if (usable.length === 0) {
      callback(new AddressRefused("its host doesn't resolve"), "", 0);
    } else if (options.all) {
      callback(null, usable);
    } else {
      callback(null, usable[0]!.address, usable[0]!.family);
    }
  };
}

/** `answer`'s body as a stream that fails with AnswerTooLarge, and closes the connection, past `MAX_ANSWER_BYTES`. */
function cappedBody(answer: http.IncomingMessage): ReadableStream<Uint8Array> {
  let received = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown) => {
        if (done) return;
        done = true;
        controller.error(error);
        answer.destroy();
      };
      answer.on("data", (chunk: Buffer) => {
        if (done) return;
        received += chunk.length;
        if (received > MAX_ANSWER_BYTES) fail(new AnswerTooLarge());
        else controller.enqueue(new Uint8Array(chunk));
      });
      answer.on("end", () => {
        if (done) return;
        done = true;
        controller.close();
      });
      answer.on("error", fail);
    },
    cancel() {
      done = true;
      answer.destroy();
    },
  });
}

/**
 * A `Fetch` whose every connection goes only to an address the URL rule accepts. It sends a string body or none,
 * honours `init.signal`, and fails the read of an answer over `MAX_ANSWER_BYTES`.
 */
export function pinnedFetch(rule: UrlRule): Fetch {
  return async (url, init) => {
    const target = new URL(url);
    const checked = await checkTarget(target, rule);
    if (!checked.ok) throw new AddressRefused(checked.reason);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new TypeError("pinnedFetch sends a string body only");
    }
    const body = init.body ?? undefined;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    const client = target.protocol === "https:" ? https : http;
    const answer = await new Promise<http.IncomingMessage>((settle, fail) => {
      const request = client.request(
        target,
        {
          method: init.method ?? "GET",
          headers,
          signal: init.signal ?? undefined,
          // Node looks up a host name through this; an address in the URL itself was checked above.
          lookup: pinnedLookup(checked.addresses),
          // A connection of its own each call, so each one is checked.
          agent: false,
        },
        settle,
      );
      request.on("error", fail);
      request.end(body);
    });
    const answerHeaders = new Headers();
    for (let index = 0; index < answer.rawHeaders.length; index += 2) {
      answerHeaders.append(answer.rawHeaders[index]!, answer.rawHeaders[index + 1]!);
    }
    const status = answer.statusCode ?? 0;
    if (NULL_BODY_STATUSES.has(status)) answer.resume();
    return new Response(NULL_BODY_STATUSES.has(status) ? null : cappedBody(answer), {
      status,
      statusText: answer.statusMessage,
      headers: answerHeaders,
    });
  };
}
