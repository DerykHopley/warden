// Configuration, read once at start-up and checked. `pg` reads the PG* variables itself; they are checked here
// so a missing one stops the server at start rather than at its first query.
import { createPrivateKey } from "node:crypto";
import { z } from "zod";

/** Clerk's Frontend API host, which a publishable key carries as base64 of `<host>$`. */
function frontendApiHost(publishableKey: string): string | undefined {
  const encoded = /^pk_(?:test|live)_(.+)$/.exec(publishableKey)?.[1];
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : undefined;
}

/**
 * A Cloud Run Job's resource name: the project (its id or number), the region and the job. A project id may hold a
 * dot (`example.com:my-project`), but never is `.` or `..`, which the starter's URL would normalise to another path.
 */
const JOB_NAME = /^projects\/(?!\.\.?\/)[a-z0-9.:-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/;

const required = z.string().min(1);
const optional = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const Env = z.object({
  CLERK_SECRET_KEY: required,
  CLERK_JWT_KEY: optional,
  VITE_CLERK_PUBLISHABLE_KEY: required.transform((key, ctx) => {
    const host = frontendApiHost(key);
    if (host === undefined) {
      ctx.addIssue({ code: "custom", message: "holds no Clerk Frontend API host" });
      return z.NEVER;
    }
    return host;
  }),
  PGHOST: required,
  PGUSER: required,
  PGDATABASE: required,
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** The dashboard origins a Clerk session token may be made for (its `azp`), comma-separated. */
  CLERK_AUTHORIZED_PARTIES: optional.transform((value, ctx) => {
    if (value === undefined) return undefined;
    const origins = value.split(",").map((origin) => origin.trim());
    if (!origins.every(isOrigin)) {
      ctx.addIssue({ code: "custom", message: "holds something that isn't an origin" });
      return z.NEVER;
    }
    return origins;
  }),
  /** Cloud Run sets it in every container it runs (its container contract). */
  K_SERVICE: optional,
  /** The Scan Job's resource name (ADR 0009), which the Cloud Run starter runs. */
  WARDEN_SCAN_JOB: optional.refine((value) => value === undefined || JOB_NAME.test(value), {
    message: "isn't projects/<project>/locations/<region>/jobs/<job>",
  }),
});

/** The App's private key as GitHub downloads it (PKCS#1 PEM): it signs the App's JWTs, so it must be RSA. */
const appPrivateKey = required.refine(isRsaPrivateKey, { message: "isn't an RSA private key" });

/** The read-only GitHub App's settings, read only when one of them is set: they come together or not at all. */
const GitHubApp = z
  .object({
    /** The App's client id: the JWT's issuer, as GitHub recommends, and the user flow's client. */
    GITHUB_APP_CLIENT_ID: required,
    GITHUB_APP_CLIENT_SECRET: required,
    GITHUB_APP_PRIVATE_KEY: appPrivateKey,
  })
  .transform((app) => ({
    clientId: app.GITHUB_APP_CLIENT_ID,
    clientSecret: app.GITHUB_APP_CLIENT_SECRET,
    privateKey: app.GITHUB_APP_PRIVATE_KEY,
  }));

/** Whether Node can read `pem` as an RSA private key, which RS256 signs with. */
function isRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

const GITHUB_VARIABLES = [
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/** `https://host[:port]` and nothing more: what a token's `azp` holds. */
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** The dashboard's origin under `pnpm dev` (Vite's port), allowed when no origins are set off Cloud Run. */
const LOCAL_DASHBOARD_ORIGIN = "http://localhost:5173";

export type Config = {
  port: number;
  /** On Cloud Run, the client's address comes from X-Forwarded-For (see `clientAddress`). */
  behindCloudRun: boolean;
  /** The Scan Job on Cloud Run, `projects/<project>/locations/<region>/jobs/<job>`; unset, Scans start another way. */
  scanJob: string | undefined;
  clerk: {
    secretKey: string;
    jwtKey: string | undefined;
    frontendApiHost: string;
    /** Only a token made for one of these origins signs anyone in; another app's on the same instance doesn't. */
    authorizedParties: string[];
  };
  /** The read-only GitHub App, which a Team's repos are linked through; unset, none can be linked. */
  github: { clientId: string; clientSecret: string; privateKey: string } | undefined;
};

/** A variable is missing or malformed. Its message names the variables, never their values. */
export class ConfigError extends Error {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(`Missing or invalid environment variable(s): ${variables.join(", ")}`);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // An empty value counts as unset: `.envrc` exports "" when a keyring entry is missing.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = Env.safeParse(present);
  // One of the App's settings without the others links nothing, and is a mistake to say at start, with the rest.
  const github = GITHUB_VARIABLES.some((name) => name in present)
    ? GitHubApp.safeParse(present)
    : undefined;
  if (!parsed.success || github?.success === false) {
    const issues = [...(parsed.error?.issues ?? []), ...(github?.error?.issues ?? [])];
    throw new ConfigError([...new Set(issues.map((issue) => String(issue.path[0])))]);
  }
  const { data } = parsed;
  const behindCloudRun = data.K_SERVICE !== undefined;
  // On Cloud Run the origins must be named: a default there would be the local one, and refuse every real token.
  if (behindCloudRun && data.CLERK_AUTHORIZED_PARTIES === undefined) {
    throw new ConfigError(["CLERK_AUTHORIZED_PARTIES"]);
  }
  return {
    port: data.PORT,
    behindCloudRun,
    scanJob: data.WARDEN_SCAN_JOB,
    clerk: {
      secretKey: data.CLERK_SECRET_KEY,
      jwtKey: data.CLERK_JWT_KEY,
      frontendApiHost: data.VITE_CLERK_PUBLISHABLE_KEY,
      authorizedParties: data.CLERK_AUTHORIZED_PARTIES ?? [LOCAL_DASHBOARD_ORIGIN],
    },
    github: github?.data,
  };
}

/** What the Scan Job reads repos with: the App's client id and private key, never its client secret. */
export type GitHubReaderSettings = { clientId: string; privateKey: string };

const GitHubReader = z
  .object({ GITHUB_APP_CLIENT_ID: required, GITHUB_APP_PRIVATE_KEY: appPrivateKey })
  .transform((app) => ({
    clientId: app.GITHUB_APP_CLIENT_ID,
    privateKey: app.GITHUB_APP_PRIVATE_KEY,
  }));

const GITHUB_READER_VARIABLES = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_PRIVATE_KEY"] as const;

/**
 * The Scan Job's GitHub settings, or undefined with neither variable set: a Guard Scan then fails, as GitHub isn't set
 * up for it. An empty value counts as unset, as in `loadConfig`. One without the other, or a key that isn't RSA, throws
 * ConfigError naming the variables, never their values. GITHUB_APP_CLIENT_SECRET is ignored.
 */
export function gitHubReaderSettings(
  env: Record<string, string | undefined>,
): GitHubReaderSettings | undefined {
  const present = Object.fromEntries(
    GITHUB_READER_VARIABLES.flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  );
  if (Object.keys(present).length === 0) return undefined;
  const parsed = GitHubReader.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]);
  }
  return parsed.data;
}
