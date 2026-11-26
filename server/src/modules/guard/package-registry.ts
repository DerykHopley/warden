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
   * other non-2xx answer, a timeout, a lost connection, and an answer with no valid version; UnpinnableVersion for a
   * valid version outside the pinned shape.
   */
  latestVersion(registry: PackageRegistryName, name: string): Promise<string | undefined>;
}

/**
 * A registry didn't answer a version: a non-2xx answer other than 404, a timeout, a lost connection, or an answer
 * without a valid version. It names the registry and the status only (undefined when none came).
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

/**
 * A registry's latest version is a valid version there, but not in the shape the scanner reads as pinned (a PyPI
 * epoch `1!2.0` or local version `1.0+ubuntu.1`), so Warden can't write a package pinned at it. It names the registry
 * only.
 */
export class UnpinnableVersion extends Error {
  override name = "UnpinnableVersion";
  readonly registry: PackageRegistryName;
  constructor(registry: PackageRegistryName) {
    super(`The ${registry} registry's latest version isn't in the pinned shape`);
    this.registry = registry;
  }
}

/** One part of an npm name: URL-safe, not starting with `.` or `_` (npm's `validate-npm-package-name`). */
const NPM_PART = String.raw`[A-Za-z0-9~-][A-Za-z0-9._~-]*`;
/** An npm package name, scoped or not, at most 214 characters. */
const NPM_NAME = new RegExp(`^(?:@${NPM_PART}/)?${NPM_PART}$`);
/** A PyPI project name (PEP 508's name, without extras or a version). */
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Any version PEP 440 allows, in any of its spellings (its appendix's pattern). */
const PEP_440 =
  /^v?(?:\d+!)?\d+(?:\.\d+)*(?:[-_.]?(?:alpha|a|beta|b|preview|pre|c|rc)[-_.]?\d*)?(?:-\d+|[-_.]?(?:post|rev|r)[-_.]?\d*)?(?:[-_.]?dev[-_.]?\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

/**
 * Each registry: which names it holds, where it answers a package's latest version, where in its answer that version
 * is, and which versions it allows at all.
 */
const REGISTRIES: Record<
  PackageRegistryName,
  {
    isName(name: string): boolean;
    url(name: string): string;
    version(body: unknown): unknown;
    isVersion(version: string): boolean;
  }
> = {
  npm: {
    isName: (name) => name.length <= 214 && NPM_NAME.test(name),
    // A scoped name's `/` is encoded, so the scope and name are one path part.
    url: (name) => `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
    version: (body) => (isObject(body) ? body.version : undefined),
    // npm's versions are semver, which the pinned shape already covers.
    isVersion: (version) => isPinnedVersion("npm", version),
  },
  pypi: {
    isName: (name) => PYPI_NAME.test(name),
    url: (name) => `https://pypi.org/pypi/${name}/json`,
    version: (body) => (isObject(body) && isObject(body.info) ? body.info.version : undefined),
    isVersion: (version) => PEP_440.test(version),
  },
};

/** Whether `name` is a valid package name on `registry`, so it can go into the registry's URL as it is. */
export const isPackageName = (registry: PackageRegistryName, name: string): boolean =>
  REGISTRIES[registry].isName(name);

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
      const { url, version, isVersion } = REGISTRIES[registry];
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
      if (typeof latest !== "string" || !isVersion(latest)) {
        throw new RegistryUnavailable(registry, answer.status);
      }
      if (!isPinnedVersion(registry, latest)) throw new UnpinnableVersion(registry);
      return latest;
    },
  };
}
