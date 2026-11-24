import { describe, expect, it } from "vitest";
import { FRONTEND_API_HOST, testPublishableKey as publishableKey } from "../test/helpers.ts";
import { ConfigError, loadConfig } from "./config.ts";

const env = {
  CLERK_SECRET_KEY: "clerk-secret-value",
  VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
  PGHOST: "127.0.0.1",
  PGUSER: "warden",
  PGDATABASE: "warden",
};

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
    const run = () =>
      loadConfig({
        VITE_CLERK_PUBLISHABLE_KEY: publishableKey,
        PGHOST: "",
        PGPASSWORD: "pw-value",
      });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      expect((error as ConfigError).variables).toEqual([
        "CLERK_SECRET_KEY",
        "PGHOST",
        "PGUSER",
        "PGDATABASE",
      ]);
      expect((error as Error).message).not.toContain("pw-value");
    }
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
