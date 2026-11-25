import { describe, expect, it } from "vitest";
import { FrameworksBody, ProductInput, ProductsBody, Usage } from "../src/index.ts";
import { expectRefused } from "./refused.ts";

const input = {
  name: "Support bot",
  repo_urls: ["https://github.com/example/support-bot"],
  dependencies: [
    { framework: "langchain", version: "0.3.27", usage: "library", internet_facing: true },
    { framework: "ollama", version: null, usage: "self_hosted", internet_facing: false },
  ],
};

describe("Usage", () => {
  it("holds Patch's four usage values, in verdict.py's order", () => {
    expect(Usage.options).toEqual(["self_hosted", "library", "transitive", "hosted"]);
  });
});

describe("ProductInput", () => {
  it("takes a name, https Repo URLs and dependencies", () => {
    expect(ProductInput.parse(input)).toEqual(input);
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

describe("the read bodies", () => {
  it("ProductsBody carries the Team and each Product with its id", () => {
    const body = { team: "org_a", products: [{ id: "p-1", ...input }] };
    expect(ProductsBody.parse(body)).toEqual(body);
  });

  it("FrameworksBody carries each framework's id, name, purls and coverage", () => {
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
