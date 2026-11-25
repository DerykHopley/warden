import { describe, expect, it } from "vitest";
import { GitHubAppBody } from "../src/index.ts";
import { expectRefused } from "./refused.ts";

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
