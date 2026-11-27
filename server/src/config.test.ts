import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRONTEND_API_HOST, testPublishableKey as publishableKey } from "../test/helpers.ts";
import {
  ConfigError,
  DEFAULT_JUDGE_MODEL,
  gitHubReaderSettings,
  judgeSettings,
  loadConfig,
} from "./config.ts";

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

/** The write GitHub app's three settings, all set. */
const githubWrite = {
  GITHUB_WRITE_APP_CLIENT_ID: "Iv23li-write-client-id-value",
  GITHUB_WRITE_APP_CLIENT_SECRET: "write-client-secret-value",
  GITHUB_WRITE_APP_PRIVATE_KEY: appKey,
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

  describe("the write GitHub app's settings", () => {
    it("reads all three into githubWrite, apart from the read app's", () => {
      const config = loadConfig({ ...env, ...githubWrite });
      expect(config.githubWrite).toEqual({
        clientId: "Iv23li-write-client-id-value",
        clientSecret: "write-client-secret-value",
        privateKey: appKey,
      });
      expect(config.github).toBeUndefined();
    });

    it("leaves githubWrite undefined when none is set", () => {
      expect(loadConfig(env).githubWrite).toBeUndefined();
    });

    it.each([
      [
        "only the client id",
        { GITHUB_WRITE_APP_CLIENT_ID: githubWrite.GITHUB_WRITE_APP_CLIENT_ID },
        ["GITHUB_WRITE_APP_CLIENT_SECRET", "GITHUB_WRITE_APP_PRIVATE_KEY"],
      ],
      [
        "the id and secret, the key empty",
        { ...githubWrite, GITHUB_WRITE_APP_PRIVATE_KEY: "" },
        ["GITHUB_WRITE_APP_PRIVATE_KEY"],
      ],
      [
        "only the secret and key",
        {
          GITHUB_WRITE_APP_CLIENT_SECRET: githubWrite.GITHUB_WRITE_APP_CLIENT_SECRET,
          GITHUB_WRITE_APP_PRIVATE_KEY: appKey,
        },
        ["GITHUB_WRITE_APP_CLIENT_ID"],
      ],
    ])("with %s, names each missing one and no value", (_name, some, missing) => {
      const error = configError(() => loadConfig({ ...env, ...some }));
      expect(error.variables).toEqual(missing);
      for (const value of Object.values(some).filter((value) => value !== "")) {
        expect(error.message).not.toContain(value);
      }
      expect(error.message).not.toContain("BEGIN");
    });

    // The read app's cases above cover each kind of bad key; this one shows the write app's key is checked the same way.
    it("refuses a private key that isn't RSA, naming only it and no value", () => {
      const error = configError(() =>
        loadConfig({ ...env, ...githubWrite, GITHUB_WRITE_APP_PRIVATE_KEY: ecKey }),
      );
      expect(error.variables).toEqual(["GITHUB_WRITE_APP_PRIVATE_KEY"]);
      expect(error.message).not.toContain("BEGIN");
      expect(error.message).not.toContain(githubWrite.GITHUB_WRITE_APP_CLIENT_SECRET);
    });

    it("names a missing write-app variable along with the read app's missing ones", () => {
      const error = configError(() =>
        loadConfig({
          ...env,
          GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value",
          GITHUB_WRITE_APP_CLIENT_ID: githubWrite.GITHUB_WRITE_APP_CLIENT_ID,
        }),
      );
      expect(error.variables).toEqual([
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_WRITE_APP_CLIENT_SECRET",
        "GITHUB_WRITE_APP_PRIVATE_KEY",
      ]);
    });
  });

  describe("the pseudonym key (WARDEN_PSEUDONYM_KEY)", () => {
    const hex = "0123456789abcdefFEDCBA9876543210".repeat(2);

    it("leaves pseudonymKey undefined when unset or empty", () => {
      expect(loadConfig(env).pseudonymKey).toBeUndefined();
      expect(loadConfig({ ...env, WARDEN_PSEUDONYM_KEY: "" }).pseudonymKey).toBeUndefined();
    });

    it("reads 64 hex digits as the key's 32 bytes", () => {
      const key = loadConfig({ ...env, WARDEN_PSEUDONYM_KEY: hex }).pseudonymKey;
      expect(key).toEqual(Buffer.from(hex, "hex"));
      expect(key?.length).toBe(32);
    });

    it.each([
      ["63 hex digits", hex.slice(1)],
      ["65 hex digits", `${hex}0`],
      ["a digit that isn't hex", `${hex.slice(1)}g`],
      ["spaces around it", ` ${hex} `],
    ])("refuses %s, naming only WARDEN_PSEUDONYM_KEY and never its value", (_name, value) => {
      const error = configError(() => loadConfig({ ...env, WARDEN_PSEUDONYM_KEY: value }));
      expect(error.variables).toEqual(["WARDEN_PSEUDONYM_KEY"]);
      expect(error.message).not.toContain(value.trim());
    });
  });

  describe("the Judge's localhost setting (WARDEN_JUDGE_LOCALHOST)", () => {
    const onCloudRun = { K_SERVICE: "warden", CLERK_AUTHORIZED_PARTIES: "https://w.example" };

    it("is on with 1, and off unset or empty", () => {
      expect(loadConfig({ ...env, WARDEN_JUDGE_LOCALHOST: "1" }).judgeLocalhost).toBe(true);
      expect(loadConfig(env).judgeLocalhost).toBe(false);
      expect(loadConfig({ ...env, WARDEN_JUDGE_LOCALHOST: "" }).judgeLocalhost).toBe(false);
    });

    it("refuses any other value, naming the variable", () => {
      const error = configError(() => loadConfig({ ...env, WARDEN_JUDGE_LOCALHOST: "yes" }));
      expect(error.variables).toEqual(["WARDEN_JUDGE_LOCALHOST"]);
    });

    it.each([
      ["K_SERVICE", onCloudRun],
      ["CLOUD_RUN_JOB", { CLOUD_RUN_JOB: "warden-scan" }],
    ])("refuses 1 on Cloud Run (%s set), naming the variable", (_name, cloudRun) => {
      const error = configError(() =>
        loadConfig({ ...env, ...cloudRun, WARDEN_JUDGE_LOCALHOST: "1" }),
      );
      expect(error.variables).toEqual(["WARDEN_JUDGE_LOCALHOST"]);
      expect(loadConfig({ ...env, ...cloudRun }).judgeLocalhost).toBe(false);
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

describe("gitHubReaderSettings (the Scan Job's)", () => {
  const reader = { GITHUB_APP_CLIENT_ID: "Iv23li-client-id-value", GITHUB_APP_PRIVATE_KEY: appKey };

  it("answers undefined with neither variable, or both empty", () => {
    expect(gitHubReaderSettings({})).toBeUndefined();
    expect(
      gitHubReaderSettings({ GITHUB_APP_CLIENT_ID: "", GITHUB_APP_PRIVATE_KEY: "" }),
    ).toBeUndefined();
  });

  it("answers the client id and key with both, needing no client secret", () => {
    expect(gitHubReaderSettings(reader)).toEqual({
      clientId: reader.GITHUB_APP_CLIENT_ID,
      privateKey: appKey,
    });
  });

  it("ignores the client secret, set or alone", () => {
    expect(
      gitHubReaderSettings({ ...reader, GITHUB_APP_CLIENT_SECRET: "client-secret-value" }),
    ).toEqual({ clientId: reader.GITHUB_APP_CLIENT_ID, privateKey: appKey });
    expect(
      gitHubReaderSettings({ GITHUB_APP_CLIENT_SECRET: "client-secret-value" }),
    ).toBeUndefined();
  });

  // A Scan only reads (G4): the write app's settings never reach the Scan Job's GitHub client.
  describe("the write app's settings", () => {
    it("answers undefined when only they are set", () => {
      expect(gitHubReaderSettings(githubWrite)).toBeUndefined();
    });

    it("are ignored when the read app's are set too", () => {
      const { privateKey: otherKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      expect(
        gitHubReaderSettings({ ...reader, ...githubWrite, GITHUB_WRITE_APP_PRIVATE_KEY: otherKey }),
      ).toEqual({ clientId: reader.GITHUB_APP_CLIENT_ID, privateKey: appKey });
    });

    it("don't fill in a read-app variable that's missing", () => {
      const error = configError(() =>
        gitHubReaderSettings({ GITHUB_APP_CLIENT_ID: reader.GITHUB_APP_CLIENT_ID, ...githubWrite }),
      );
      expect(error.variables).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    });
  });

  it.each([
    [
      "the client id alone",
      { GITHUB_APP_CLIENT_ID: reader.GITHUB_APP_CLIENT_ID },
      "GITHUB_APP_PRIVATE_KEY",
    ],
    ["the key alone", { GITHUB_APP_PRIVATE_KEY: appKey }, "GITHUB_APP_CLIENT_ID"],
    [
      "the key with an empty client id",
      { ...reader, GITHUB_APP_CLIENT_ID: "" },
      "GITHUB_APP_CLIENT_ID",
    ],
  ])("refuses %s, naming the missing variable and no value", (_name, some, missing) => {
    const error = configError(() => gitHubReaderSettings(some));
    expect(error.variables).toEqual([missing]);
    expect(error.message).not.toContain("BEGIN");
    expect(error.message).not.toContain(reader.GITHUB_APP_CLIENT_ID);
  });

  it.each([
    ["a value that isn't a PEM", "not-a-key-value"],
    ["a public key", publicKey],
    ["a private key that isn't RSA", ecKey],
  ])("refuses a key that is %s, naming GITHUB_APP_PRIVATE_KEY and no value", (_name, value) => {
    const error = configError(() =>
      gitHubReaderSettings({ ...reader, GITHUB_APP_PRIVATE_KEY: value }),
    );
    expect(error.variables).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain("BEGIN");
  });
});

describe("judgeSettings (the Scan Job's, for a Judge run)", () => {
  it("reads the key and the model", () => {
    expect(
      judgeSettings({ OPENROUTER_API_KEY: "sk-or-v1-abc", WARDEN_JUDGE_MODEL: "test/model" }),
    ).toEqual({
      apiKey: "sk-or-v1-abc",
      model: "test/model",
      allowLocalhost: false,
      langfuse: undefined,
    });
  });

  it.each([
    ["unset", {}],
    [
      "empty",
      {
        OPENROUTER_API_KEY: "",
        WARDEN_JUDGE_MODEL: "",
        WARDEN_JUDGE_LOCALHOST: "",
        LANGFUSE_PUBLIC_KEY: "",
        LANGFUSE_SECRET_KEY: "",
        LANGFUSE_BASE_URL: "",
      },
    ],
  ])(
    "leaves the key undefined, takes Claude Haiku 5.5, keeps localhost off and traces nothing when they're %s",
    (_name, env) => {
      expect(judgeSettings(env)).toEqual({
        apiKey: undefined,
        model: DEFAULT_JUDGE_MODEL,
        allowLocalhost: false,
        langfuse: undefined,
      });
      expect(DEFAULT_JUDGE_MODEL).toBe("anthropic/claude-haiku-5.5");
    },
  );

  it("reads both Langfuse keys, with Langfuse's EU region unless LANGFUSE_BASE_URL names another", () => {
    const keys = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-1" };
    expect(judgeSettings(keys).langfuse).toEqual({
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-1",
      baseUrl: "https://cloud.langfuse.com",
    });
    expect(
      judgeSettings({ ...keys, LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com" }).langfuse
        ?.baseUrl,
    ).toBe("https://us.cloud.langfuse.com");
  });

  it.each([
    ["LANGFUSE_PUBLIC_KEY", { LANGFUSE_PUBLIC_KEY: "pk-lf-planted" }, "LANGFUSE_SECRET_KEY"],
    ["LANGFUSE_SECRET_KEY", { LANGFUSE_SECRET_KEY: "sk-lf-planted" }, "LANGFUSE_PUBLIC_KEY"],
  ])("refuses %s alone, naming the one missing and no value", (_name, env, missing) => {
    const error = configError(() => judgeSettings(env));
    expect(error.variables).toEqual([missing]);
    expect(error.message).not.toContain("planted");
  });

  it.each(["http://langfuse.example", "langfuse.example", "ftp://langfuse.example"])(
    "refuses LANGFUSE_BASE_URL=%s, which isn't https, naming the variable",
    (url) => {
      const error = configError(() =>
        judgeSettings({
          LANGFUSE_PUBLIC_KEY: "pk-lf-1",
          LANGFUSE_SECRET_KEY: "sk-lf-1",
          LANGFUSE_BASE_URL: url,
        }),
      );
      expect(error.variables).toEqual(["LANGFUSE_BASE_URL"]);
      expect(error.message).not.toContain("langfuse.example");
    },
  );

  it("traces nothing, and doesn't stop the run, for a LANGFUSE_BASE_URL that isn't https with neither key set", () => {
    expect(judgeSettings({ LANGFUSE_BASE_URL: "http://langfuse.example" }).langfuse).toBeUndefined();
  });

  it("turns localhost on with WARDEN_JUDGE_LOCALHOST=1", () => {
    expect(judgeSettings({ WARDEN_JUDGE_LOCALHOST: "1" }).allowLocalhost).toBe(true);
  });

  it("refuses WARDEN_JUDGE_LOCALHOST=yes, naming the variable", () => {
    expect(configError(() => judgeSettings({ WARDEN_JUDGE_LOCALHOST: "yes" })).variables).toEqual([
      "WARDEN_JUDGE_LOCALHOST",
    ]);
  });

  it.each(["K_SERVICE", "CLOUD_RUN_JOB"])(
    "refuses WARDEN_JUDGE_LOCALHOST=1 with %s set, naming the variable",
    (cloudRun) => {
      const error = configError(() =>
        judgeSettings({ WARDEN_JUDGE_LOCALHOST: "1", [cloudRun]: "warden-scan" }),
      );
      expect(error.variables).toEqual(["WARDEN_JUDGE_LOCALHOST"]);
    },
  );
});
