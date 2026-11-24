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
});

export type Config = {
  port: number;
  clerk: { secretKey: string; jwtKey: string | undefined; frontendApiHost: string };
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
  return {
    port: data.PORT,
    clerk: {
      secretKey: data.CLERK_SECRET_KEY,
      jwtKey: data.CLERK_JWT_KEY,
      frontendApiHost: data.VITE_CLERK_PUBLISHABLE_KEY,
    },
  };
}
