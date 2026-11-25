import { describe, expect, it } from "vitest";
import { FrameworksBody, ProductInput } from "../src/index.ts";
import { expectIssueAt, expectRefused } from "./refused.ts";

const input = {
  name: "Support bot",
  repo_urls: ["https://github.com/example/support-bot"],
  dependencies: [
    { framework: "langchain", version: "0.3.27", usage: "library", internet_facing: true },
    { framework: "ollama", version: null, usage: "self_hosted", internet_facing: false },
  ],
};

describe("ProductInput", () => {
  it("takes a name, https Repo URLs and dependencies", () => {
    expect(ProductInput.parse(input)).toEqual(input);
  });

  it("trims the name, so 200 characters with spaces around them are taken", () => {
    const name = "x".repeat(200);
    expect(ProductInput.parse({ ...input, name: `  ${name} ` }).name).toBe(name);
    expect(ProductInput.parse({ ...input, name: "Checkout " }).name).toBe("Checkout");
    expectRefused(ProductInput, { ...input, name: "x".repeat(201) }, "name");
  });

  it("takes 12 dependencies, one per framework, and refuses 13", () => {
    const dependencies = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...input.dependencies[0]!, framework: `fw-${i}` }));
    expect(ProductInput.safeParse({ ...input, dependencies: dependencies(12) }).success).toBe(true);
    expectRefused(ProductInput, { ...input, dependencies: dependencies(13) }, "dependencies");
  });

  it("refuses the same framework twice, naming the second", () => {
    const body = {
      ...input,
      dependencies: [
        ...input.dependencies,
        { ...input.dependencies[0]!, version: "0.3.28", usage: "transitive" },
      ],
    };
    expectIssueAt(ProductInput, body, ["dependencies", 2, "framework"], /dependencies\[0\]/);
  });

  it("takes 20 Repo URLs and refuses 21", () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://github.com/example/repo-${i}`);
    expect(ProductInput.safeParse({ ...input, repo_urls: urls(20) }).success).toBe(true);
    expectRefused(ProductInput, { ...input, repo_urls: urls(21) }, "repo_urls");
  });

  it.each([
    ["an http Repo URL", { ...input, repo_urls: ["http://github.com/example/app"] }, "repo_urls"],
    ["a blank name", { ...input, name: " " }, "name"],
    [
      "a usage outside Usage",
      { ...input, dependencies: [{ ...input.dependencies[0]!, usage: "vendored" }] },
      "usage",
    ],
    ["a team", { ...input, team: "org_other" }, "team"],
  ])("refuses %s", (_name, body, field) => {
    expectRefused(ProductInput, body, field);
  });
});

describe("FrameworksBody", () => {
  it("carries each framework's id, name, purls and coverage", () => {
    const body = {
      frameworks: [
        { id: "dify", name: "Dify", purls: [], coverage: "none" },
        { id: "vllm", name: "vLLM", purls: ["pkg:pypi/vllm"], coverage: "package" },
      ],
    };
    expect(FrameworksBody.parse(body)).toEqual(body);
    expectRefused(
      FrameworksBody,
      { frameworks: [{ ...body.frameworks[0], coverage: "partial" }] },
      "coverage",
    );
  });
});
