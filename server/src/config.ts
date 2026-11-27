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
  /** The key every Team's pseudonym key is derived from (docs/data.md, "The pseudonym"): 64 hex digits. */
  WARDEN_PSEUDONYM_KEY: optional
    .refine((value) => value === undefined || /^[0-9a-f]{64}$/i.test(value), {
      message: "isn't 64 hex digits",
    })
    .transform((value) => (value === undefined ? undefined : Buffer.from(value, "hex"))),
});

/** The App's private key as GitHub downloads it (PKCS#1 PEM): it signs the App's JWTs, so it must be RSA. */
const appPrivateKey = required.refine(isRsaPrivateKey, { message: "isn't an RSA private key" });

/** A GitHub App's settings, checked. The client id is the JWT's issuer, as GitHub recommends, and the user flow's client. */
const GitHubApp = z.object({
  clientId: required,
  clientSecret: required,
  privateKey: appPrivateKey,
});

/**
 * One GitHub App's settings from its three variables, `<prefix>_CLIENT_ID`, `<prefix>_CLIENT_SECRET` and
 * `<prefix>_PRIVATE_KEY`, read only when one of them is in `present`: they come together or not at all. Answers the
 * settings (undefined with none set), or the variables that are missing or malformed, never their values.
 */
function readGitHubApp(
  present: Record<string, string | undefined>,
  prefix: "GITHUB_APP" | "GITHUB_WRITE_APP",
): { settings: GitHubAppSettings | undefined; invalid: string[] } {
  const variables = {
    clientId: `${prefix}_CLIENT_ID`,
    clientSecret: `${prefix}_CLIENT_SECRET`,
    privateKey: `${prefix}_PRIVATE_KEY`,
  } satisfies Record<keyof GitHubAppSettings, string>;
  if (!Object.values(variables).some((name) => name in present)) {
    return { settings: undefined, invalid: [] };
  }
  const parsed = GitHubApp.safeParse({
    clientId: present[variables.clientId],
    clientSecret: present[variables.clientSecret],
    privateKey: present[variables.privateKey],
  });
  if (parsed.success) return { settings: parsed.data, invalid: [] };
  const failed = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  return {
    settings: undefined,
    invalid: Object.entries(variables).flatMap(([setting, name]) =>
      failed.has(setting) ? [name] : [],
    ),
  };
}

/** Whether Node can read `pem` as an RSA private key, which RS256 signs with. */
function isRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

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
  github: GitHubAppSettings | undefined;
  /** The write GitHub App, which Fix PRs go through with a Team's write grant; unset, none can be opened. */
  githubWrite: GitHubAppSettings | undefined;
  /** The pseudonym key's 32 bytes, which the hook endpoint derives each Team's key from; unset, it answers 503. */
  pseudonymKey: Buffer | undefined;
  /** WARDEN_JUDGE_LOCALHOST: an Admin may name a local Judge model on localhost (local development only). */
  judgeLocalhost: boolean;
};

/**
 * WARDEN_JUDGE_LOCALHOST, which lets a Team's own Judge model be on `localhost`, `127.0.0.1` or `[::1]`: `1` turns it
 * on, unset or empty leaves it off, and any other value throws ConfigError naming it. On Cloud Run (K_SERVICE in a
 * service, CLOUD_RUN_JOB in a Job's container) it throws too, so the live app never runs with it.
 */
function readJudgeLocalhost(env: Record<string, string | undefined>): boolean {
  const value = env.WARDEN_JUDGE_LOCALHOST || undefined;
  if (value === undefined) return false;
  const onCloudRun = Boolean(env.K_SERVICE) || Boolean(env.CLOUD_RUN_JOB);
  if (value !== "1" || onCloudRun) throw new ConfigError(["WARDEN_JUDGE_LOCALHOST"]);
  return true;
}

/** A GitHub App's settings: its client id and secret, and the private key it signs its JWTs with. */
export type GitHubAppSettings = { clientId: string; clientSecret: string; privateKey: string };

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
  // One of an App's settings without the others links nothing, and is a mistake to say at start, with the rest.
  const github = readGitHubApp(present, "GITHUB_APP");
  const githubWrite = readGitHubApp(present, "GITHUB_WRITE_APP");
  const invalid = [
    ...(parsed.error?.issues ?? []).map((issue) => String(issue.path[0])),
    ...github.invalid,
    ...githubWrite.invalid,
  ];
  if (!parsed.success || invalid.length > 0) throw new ConfigError([...new Set(invalid)]);
  const { data } = parsed;
  const behindCloudRun = data.K_SERVICE !== undefined;
  // On Cloud Run the origins must be named: a default there would be the local one, and refuse every real token.
  if (behindCloudRun && data.CLERK_AUTHORIZED_PARTIES === undefined) {
    throw new ConfigError(["CLERK_AUTHORIZED_PARTIES"]);
  }
  const judgeLocalhost = readJudgeLocalhost(present);
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
    github: github.settings,
    githubWrite: githubWrite.settings,
    pseudonymKey: data.WARDEN_PSEUDONYM_KEY,
    judgeLocalhost,
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

/** Claude Haiku 5.5's OpenRouter slug (openrouter.ai/api/v1/models): the Judge's model unless WARDEN_JUDGE_MODEL names one. */
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-5.5";

/**
 * The key and model a Judge run calls OpenRouter with, and whether a Team's own model may be on localhost
 * (WARDEN_JUDGE_LOCALHOST).
 */
export type JudgeSettings = { apiKey: string | undefined; model: string; allowLocalhost: boolean };

/**
 * The Scan Job's settings for a Judge run: OPENROUTER_API_KEY, WARDEN_JUDGE_MODEL or `DEFAULT_JUDGE_MODEL`, and
 * WARDEN_JUDGE_LOCALHOST, read as `loadConfig` reads it (a bad value, or one on Cloud Run, throws ConfigError). An
 * empty value counts as unset, as in `loadConfig`. An unset key isn't refused here: the run refuses it after reading
 * the session, before its model call, so a session with nothing to judge (or one judged by the Team's own model) runs
 * without it.
 */
export function judgeSettings(env: Record<string, string | undefined>): JudgeSettings {
  return {
    apiKey: env.OPENROUTER_API_KEY || undefined,
    model: env.WARDEN_JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
    allowLocalhost: readJudgeLocalhost(env),
  };
}
