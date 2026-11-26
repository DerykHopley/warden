// The npm and PyPI latest-version lookup a Fix PR for `guard/mcp-server-unpinned` pins a server's package with (spec
// #224, story 6). Each registry's public JSON API is read with no key, and only the package's name is sent. A name
// is checked before it goes into a URL, so none can change the URL's path, and a version is checked against the
// scanner's pinned-version shape before it is answered, so no other text a registry sends gets into a repo.
import { CallFailed, callJson, type Fetch } from "../../http-call.ts";
import { isObject } from "./json-config.ts";
import { isPinnedVersion, type PackageRegistryName } from "./mcp-servers.ts";

/** The latest-version lookup: npm's or PyPI's `latest` for a package. */
export interface PackageRegistry {
  /**
   * The package's `latest` version on `registry`, or undefined when the registry doesn't hold it (a 404). A name that
   * isn't a valid package name there is refused with a RangeError before any call. Throws RegistryUnavailable for any
   * other non-2xx answer, a timeout, a lost connection, and an answer with no version in the pinned shape.
   */
  latestVersion(registry: PackageRegistryName, name: string): Promise<string | undefined>;
}

/**
 * A registry didn't answer a version: a non-2xx answer other than 404, a timeout, a lost connection, or an answer
 * without a version in the pinned shape. It names the registry and the status only (undefined when none came).
 */
export class RegistryUnavailable extends Error {
  override name = "RegistryUnavailable";
  readonly registry: PackageRegistryName;
  readonly status: number | undefined;
  constructor(registry: PackageRegistryName, status: number | undefined, options?: ErrorOptions) {
    super(
      status === undefined
        ? `The ${registry} registry didn't answer`
        : `The ${registry} registry answered HTTP ${status} without a version`,
      options,
    );
    this.registry = registry;
    this.status = status;
  }
}

/** One part of an npm name: URL-safe, not starting with `.` or `_` (npm's `validate-npm-package-name`). */
const NPM_PART = String.raw`[A-Za-z0-9~-][A-Za-z0-9._~-]*`;
/** An npm package name, scoped or not, at most 214 characters. */
const NPM_NAME = new RegExp(`^(?:@${NPM_PART}/)?${NPM_PART}$`);
/** A PyPI project name (PEP 508's name, without extras or a version). */
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Whether `name` is a valid package name on `registry`, so it can go into the registry's URL as it is. */
export function isPackageName(registry: PackageRegistryName, name: string): boolean {
  return registry === "npm" ? name.length <= 214 && NPM_NAME.test(name) : PYPI_NAME.test(name);
}

/** Where each registry answers a package's latest version, and where in its answer that version is. */
const REGISTRIES: Record<
  PackageRegistryName,
  { url(name: string): string; version(body: unknown): unknown }
> = {
  npm: {
    // A scoped name's `/` is encoded, so the scope and name are one path part.
    url: (name) => `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
    version: (body) => (isObject(body) ? body.version : undefined),
  },
  pypi: {
    url: (name) => `https://pypi.org/pypi/${name}/json`,
    version: (body) => (isObject(body) && isObject(body.info) ? body.info.version : undefined),
  },
};

export function createPackageRegistry({
  fetch = globalThis.fetch,
  timeoutMs = 10_000,
}: {
  fetch?: Fetch;
  timeoutMs?: number;
} = {}): PackageRegistry {
  return {
    async latestVersion(registry, name) {
      if (!isPackageName(registry, name)) {
        throw new RangeError(`not a valid ${registry} package name`);
      }
      const { url, version } = REGISTRIES[registry];
      let answer;
      try {
        answer = await callJson(fetch, {
          step: `${registry} latest version`,
          url: url(name),
          init: { headers: { Accept: "application/json" } },
          timeoutMs,
        });
      } catch (error) {
        if (!(error instanceof CallFailed)) throw error;
        throw new RegistryUnavailable(registry, error.status, { cause: error.cause });
      }
      if (answer.status === 404) return undefined;
      const latest = answer.ok ? version(answer.body) : undefined;
      if (typeof latest !== "string" || !isPinnedVersion(registry, latest)) {
        throw new RegistryUnavailable(registry, answer.status);
      }
      return latest;
    },
  };
}
