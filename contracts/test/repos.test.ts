import { describe, expect, it } from "vitest";
import { GitHubAppBody, LinkedInstallationBody } from "../src/index.ts";
import { expectRefused } from "./refused.ts";

const web = {
  asset: { kind: "repo", ref: "https://github.com/acme/web" },
  installation_id: 42,
  listed_at: "2026-11-25T09:00:00.000Z",
} as const;

const scan = {
  id: "0b6f1e9c-2d1f-4c55-9a3e-7f1d2c3b4a5e",
  module: "guard",
  state: "queued",
  assets: [web.asset],
  rules: ["guard/secret-in-repo"],
  queued_at: "2026-11-25T09:00:01.000Z",
  started_at: null,
  ended_at: null,
} as const;

describe("LinkedInstallationBody", () => {
  it.each([
    ["the first Scan the link started", scan],
    ["null, when the link started none", null],
  ])("accepts %s in scan", (_name, value) => {
    const body = { installation_id: 42, repos: [web], scan: value };

    expect(LinkedInstallationBody.parse(body)).toEqual(body);
  });

  it.each([
    ["no scan", { installation_id: 42, repos: [web] }],
    ["a scan that isn't a Scan", { installation_id: 42, repos: [web], scan: { id: "x" } }],
  ])("refuses %s", (_name, body) => {
    expectRefused(LinkedInstallationBody, body, "scan");
  });
});

const app = { slug: "warden-reader", client_id: "Iv23li-the-client-id" };

describe("GitHubAppBody", () => {
  it("accepts the App's slug and client id", () => {
    expect(GitHubAppBody.parse(app)).toEqual(app);
  });

  it.each([
    ["no slug", { client_id: app.client_id }, "slug"],
    ["an empty slug", { ...app, slug: "" }, "slug"],
    ["no client id", { slug: app.slug }, "client_id"],
    ["an empty client id", { ...app, client_id: "" }, "client_id"],
    ["a field outside the two", { ...app, secret: "x" }, "secret"],
  ])("refuses %s", (_name, body, field) => {
    expectRefused(GitHubAppBody, body, field);
  });
});
