import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRONTEND_API_HOST, testPublishableKey as publishableKey } from "../test/helpers.ts";
import { ConfigError, loadConfig } from "./config.ts";

/** A GitHub App's key as GitHub downloads it: PKCS#1 PEM, `BEGIN RSA PRIVATE KEY`. */
const { privateKey: appKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ecKey = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const env = {
  CLERK_SECRET_KEY: "clerk-secret-value",
  VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
  PGHOST: "127.0.0.1",
  PGUSER: "warden",
  PGDATABASE: "warden",
};

/** The ConfigError `run` throws. */
function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("loadConfig answered");
}

describe("loadConfig", () => {
  it("reads the variables and defaults PORT to 8080", () => {
    const config = loadConfig(env);
    expect(config.port).toBe(8080);
    expect(config.clerk.secretKey).toBe("clerk-secret-value");
    expect(config.clerk.jwtKey).toBeUndefined();
  });

  it("reads PORT and the optional JWT public key", () => {
    const config = loadConfig({ ...env, PORT: "9123", CLERK_JWT_KEY: "pem" });
    expect(config.port).toBe(9123);
    expect(config.clerk.jwtKey).toBe("pem");
  });

  it("finds Clerk's Frontend API host in the publishable key", () => {
    expect(loadConfig(env).clerk.frontendApiHost).toBe(FRONTEND_API_HOST);
  });

  it("names every missing required variable, empty counting as missing, and no value", () => {
    const error = configError(() =>
      loadConfig({
        VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
        PGHOST: "",
        PGPASSWORD: "pw-value",
      }),
    );
    expect(error.variables).toEqual(["CLERK_SECRET_KEY", "PGHOST", "PGUSER", "PGDATABASE"]);
    expect(error.message).not.toContain("pw-value");
  });

  it("refuses a publishable key that holds no Frontend API host, without printing it", () => {
    const bad = "pk_test_bm90LWEtaG9zdA";
    const run = () => loadConfig({ ...env, VITE_CLERK_PUBLISHABLE_KEY: bad });
    expect(run).toThrow(/VITE_CLERK_PUBLISHABLE_KEY/);
    expect(run).not.toThrow(new RegExp(bad));
  });

  it("refuses a PORT that isn't a port number", () => {
    expect(() => loadConfig({ ...env, PORT: "http" })).toThrow(/PORT/);
  });

  it("knows it's on Cloud Run when K_SERVICE is set, and not otherwise", () => {
    const onCloudRun = {
      ...env,
      K_SERVICE: "warden",
      CLERK_AUTHORIZED_PARTIES: "https://w.example",
    };
    expect(loadConfig(onCloudRun).behindCloudRun).toBe(true);
    expect(loadConfig(env).behindCloudRun).toBe(false);
    expect(loadConfig({ ...env, K_SERVICE: "" }).behindCloudRun).toBe(false);
  });

  it("reads the dashboard origins Clerk tokens may be made for, comma-separated", () => {
    const config = loadConfig({
      ...env,
      CLERK_AUTHORIZED_PARTIES: "https://warden.example, https://preview.warden.example",
    });
    expect(config.clerk.authorizedParties).toEqual([
      "https://warden.example",
      "https://preview.warden.example",
    ]);
  });

  it("defaults the origins to the local dashboard's, off Cloud Run only", () => {
    expect(loadConfig(env).clerk.authorizedParties).toEqual(["http://localhost:5173"]);
    expect(() => loadConfig({ ...env, K_SERVICE: "warden" })).toThrow(/CLERK_AUTHORIZED_PARTIES/);
  });

  it("reads the Scan Job's resource name, and leaves it undefined when unset or empty", () => {
    const name = "projects/p/locations/europe-west1/jobs/warden-scan";
    expect(loadConfig({ ...env, WARDEN_SCAN_JOB: name }).scanJob).toBe(name);
    expect(loadConfig(env).scanJob).toBeUndefined();
    expect(loadConfig({ ...env, WARDEN_SCAN_JOB: "" }).scanJob).toBeUndefined();
  });

  it.each([
    "projects/example.com:my-project/locations/europe-west1/jobs/warden-scan",
    "projects/123456789/locations/europe-west1/jobs/warden-scan",
  ])("accepts a Scan Job in a domain-scoped project or a project number: %s", (name) => {
    expect(loadConfig({ ...env, WARDEN_SCAN_JOB: name }).scanJob).toBe(name);
  });

  it.each([
    ["a bare job name", "warden-scan"],
    ["a URL", "https://run.googleapis.com/v2/projects/p/locations/europe-west1/jobs/warden-scan"],
    ["a project of ..", "projects/../locations/r/jobs/j"],
    ["a project of .", "projects/./locations/r/jobs/j"],
  ])("refuses a Scan Job named by %s, naming only WARDEN_SCAN_JOB", (_name, value) => {
    const error = configError(() => loadConfig({ ...env, WARDEN_SCAN_JOB: value }));
    expect(error.variables).toEqual(["WARDEN_SCAN_JOB"]);
  });

  describe("the GitHub app's settings", () => {
    const github = {
      GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
      GITHUB_APP_CLIENT_SECRET: "client-secret-value",
      GITHUB_APP_PRIVATE_KEY: appKey,
    };

    it("reads all three into github", () => {
      expect(loadConfig({ ...env, ...github }).github).toEqual({
        clientId: "Iv23li-client-id-value",
        clientSecret: "client-secret-value",
        privateKey: appKey,
      });
    });

    it("leaves github undefined when none is set, or all are empty", () => {
      expect(loadConfig(env).github).toBeUndefined();
      const empty = {
        GITHUB_APP_CLIENT_ID: "",
        GITHUB_APP_CLIENT_SECRET: "",
        GITHUB_APP_PRIVATE_KEY: "",
      };
      expect(loadConfig({ ...env, ...empty }).github).toBeUndefined();
    });

    it.each([
      [
        "only the client id",
        { GITHUB_APP_CLIENT_ID: github.GITHUB_APP_CLIENT_ID },
        ["GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"],
      ],
      [
        "the id and secret, the key empty",
        { ...github, GITHUB_APP_PRIVATE_KEY: "" },
        ["GITHUB_APP_PRIVATE_KEY"],
      ],
      [
        "only the secret and key",
        {
          GITHUB_APP_CLIENT_SECRET: github.GITHUB_APP_CLIENT_SECRET,
          GITHUB_APP_PRIVATE_KEY: appKey,
        },
        ["GITHUB_APP_CLIENT_ID"],
      ],
    ])("with %s, names each missing one and no value", (_name, some, missing) => {
      const error = configError(() => loadConfig({ ...env, ...some }));
      expect(error.variables).toEqual(missing);
      for (const value of Object.values(some).filter((value) => value !== "")) {
        expect(error.message).not.toContain(value);
      }
      expect(error.message).not.toContain("BEGIN");
    });

    it.each([
      ["a value that isn't a PEM", "not-a-key-value"],
      ["a public key", publicKey],
      ["a private key that isn't RSA", ecKey],
    ])("refuses a private key that is %s, naming only it and no value", (_name, value) => {
      const error = configError(() =>
        loadConfig({ ...env, ...github, GITHUB_APP_PRIVATE_KEY: value }),
      );
      expect(error.variables).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
      expect(error.message).not.toContain(value);
      expect(error.message).not.toContain("BEGIN");
      expect(error.message).not.toContain(github.GITHUB_APP_CLIENT_SECRET);
    });

    it("names the missing ones along with a key that isn't one", () => {
      const error = configError(() =>
        loadConfig({
          ...env,
          GITHUB_APP_CLIENT_ID: github.GITHUB_APP_CLIENT_ID,
          GITHUB_APP_PRIVATE_KEY: "not-a-key-value",
        }),
      );
      expect(error.variables).toEqual(["GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]);
      expect(error.message).not.toContain("not-a-key-value");
    });

    it("names a missing GitHub variable along with a missing required one", () => {
      const error = configError(() =>
        loadConfig({
          ...env,
          CLERK_SECRET_KEY: "",
          GITHUB_APP_CLIENT_ID: github.GITHUB_APP_CLIENT_ID,
        }),
      );
      expect(error.variables).toEqual([
        "CLERK_SECRET_KEY",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_PRIVATE_KEY",
      ]);
    });
  });

  it.each([
    ["a path", "https://warden.example/app"],
    ["no scheme", "warden.example"],
    ["an empty entry", "https://warden.example,,"],
  ])("refuses an origin with %s", (_name, value) => {
    expect(() => loadConfig({ ...env, CLERK_AUTHORIZED_PARTIES: value })).toThrow(
      /CLERK_AUTHORIZED_PARTIES/,
    );
  });
});
