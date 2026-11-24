// Test seams: a key pair standing in for a Clerk instance, and an app wired as production wires it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { HealthBody } from "@warden/contracts";
import { createApp } from "../src/app.ts";
import { createClerkVerifier } from "../src/auth.ts";
import { createLogger } from "../src/log.ts";

export const FRONTEND_API_HOST = "warden-test.clerk.accounts.dev";

/** A publishable key naming FRONTEND_API_HOST, as Clerk encodes it: base64 of `<host>$`. */
export const testPublishableKey = `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64")}`;

/** A signing key and its PEM public key, as Clerk's dashboard shows it for networkless verification. */
export async function testKey() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return { privateKey, publicPem: await exportSPKI(publicKey) };
}

/** A session token shaped like Clerk's, signed with `key`. `expiresIn` is seconds from now; negative is past. */
export function sessionToken(key: CryptoKey, userId: string, expiresIn = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (
    new SignJWT({ sid: "sess_test", azp: "http://localhost:5173" })
      // `cat` is the category Clerk's SDK puts on a session token's header, and checks.
      .setProtectedHeader({ alg: "RS256", kid: "ins_test", typ: "JWT", cat: "cl_B7d4PD111AAA" })
      .setSubject(userId)
      .setIssuer(`https://${FRONTEND_API_HOST}`)
      .setIssuedAt(now - 120)
      .setNotBefore(now - 120)
      .setExpirationTime(now + expiresIn)
      .sign(key)
  );
}

/** A built dashboard's files in a throwaway folder. */
export function dashboardDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warden-dashboard-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Warden</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('warden');");
  return dir;
}

const healthy: HealthBody = { status: "ok", database: "ok", vector: "available" };

/** The app with a real Clerk verifier over `publicPem`, and the log lines it writes. */
export function testApp(options: { publicPem: string; checkHealth?: () => Promise<HealthBody> }) {
  const lines: string[] = [];
  const app = createApp({
    logger: createLogger((line) => lines.push(line)),
    verifySessionToken: createClerkVerifier({
      secretKey: "unused-in-tests",
      jwtKey: options.publicPem,
    }),
    checkHealth: options.checkHealth ?? (async () => healthy),
    frontendApiHost: FRONTEND_API_HOST,
    dashboardDir: dashboardDir(),
  });
  return { app, lines };
}
