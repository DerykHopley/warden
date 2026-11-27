// The connection to a Team's own Judge model (spec #225, slice 6a), pinned to the address it checked. `pinnedFetch`
// answers a `Fetch` that makes its request with `node:http` or `node:https`, resolving the host through the request's
// own `lookup`: when any address the host resolves to is one the URL rule refuses, the lookup fails with the reason and
// no connection opens; otherwise the connection goes to the addresses just checked, so a DNS change between a check
// and the connect can't slip through. It never follows a redirect: a 3xx is answered as it is.
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { buffer } from "node:stream/consumers";
import type { Fetch } from "../../http-call.ts";
import {
  AddressRefused,
  addressRefusal,
  isLocalHost,
  literalAddress,
  resolveHost,
  type Resolve,
} from "./judge-url.ts";

/** Statuses whose answer has no body, which `Response` refuses one for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** A lookup through `resolve` that fails with the reason when any address the host resolves to is refused. */
function checkedLookup(resolve: Resolve, local: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          callback(new AddressRefused("its host doesn't resolve"), "", 0);
          return;
        }
        for (const { address } of answers) {
          const reason = addressRefusal(address, local);
          if (reason !== undefined) {
            callback(new AddressRefused(reason), "", 0);
            return;
          }
        }
        const family = options.family === 4 || options.family === 6 ? options.family : undefined;
        const usable = answers.filter((answer) => family === undefined || answer.family === family);
        if (usable.length === 0) {
          callback(new AddressRefused("its host doesn't resolve"), "", 0);
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, usable[0]!.address, usable[0]!.family);
        }
      },
      () => callback(new AddressRefused("its host doesn't resolve"), "", 0),
    );
  };
}

/**
 * A `Fetch` whose every connection goes only to an address the URL rule accepts, for the server's localhost setting
 * `allowLocalhost`. It sends a string body or none, honours `init.signal`, and reads the whole answer before it
 * answers.
 */
export function pinnedFetch({
  allowLocalhost,
  resolve = resolveHost,
}: {
  allowLocalhost: boolean;
  resolve?: Resolve;
}): Fetch {
  return async (url, init) => {
    const target = new URL(url);
    const local = isLocalHost(target.hostname, allowLocalhost);
    // Node doesn't look up an address in the URL itself, so it is checked here.
    const literal = literalAddress(target.hostname);
    if (literal !== undefined) {
      const reason = addressRefusal(literal, local);
      if (reason !== undefined) throw new AddressRefused(reason);
    }
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
          lookup: checkedLookup(resolve, local),
          // A connection of its own each call, so each one is checked.
          agent: false,
        },
        settle,
      );
      request.on("error", fail);
      request.end(body);
    });
    const content = await buffer(answer);
    const answerHeaders = new Headers();
    for (let index = 0; index < answer.rawHeaders.length; index += 2) {
      answerHeaders.append(answer.rawHeaders[index]!, answer.rawHeaders[index + 1]!);
    }
    const status = answer.statusCode ?? 0;
    return new Response(NULL_BODY_STATUSES.has(status) ? null : content, {
      status,
      statusText: answer.statusMessage,
      headers: answerHeaders,
    });
  };
}
