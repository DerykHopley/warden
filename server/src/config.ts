// Configuration, read once at start-up and checked. `pg` reads the PG* variables itself; they are checked here
// so a missing one stops the server at start rather than at its first query.
import { z } from "zod";

/** Clerk's Frontend API host, which a publishable key carries as base64 of `<host>$`. */
function frontendApiHost(publishableKey: string): string | undefined {
  const encoded = /^pk_(?:test|live)_(.+)$/.exec(publishableKey)?.[1];
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : undefined;
}

/** A Cloud Run Job's resource name: the project (its id or number), the region and the job. */
const JOB_NAME = /^projects\/[a-z0-9.:-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/;

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
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]);
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
  };
}
