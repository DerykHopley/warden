import { type Coverage, Framework } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { PATCH_FRAMEWORKS } from "./frameworks.ts";

const byId = (id: string) => PATCH_FRAMEWORKS.find((framework) => framework.id === id);

describe("PATCH_FRAMEWORKS", () => {
  it("lists Patch's 12 frameworks, each once, as the Framework contract", () => {
    expect(PATCH_FRAMEWORKS.map((framework) => framework.id)).toEqual([
      "langflow",
      "open-webui",
      "flowise",
      "vllm",
      "langchain",
      "gradio",
      "litellm",
      "ollama",
      "llamaindex",
      "llama.cpp",
      "dify",
      "anything-llm",
    ]);
    for (const framework of PATCH_FRAMEWORKS) expect(Framework.parse(framework)).toEqual(framework);
  });

  it("names each framework for display as Patch does", () => {
    expect(byId("open-webui")?.name).toBe("Open WebUI");
  });

  it("gives each package as a purl without a version, by ecosystem", () => {
    expect(byId("langchain")?.purls).toEqual([
      "pkg:pypi/langchain",
      "pkg:pypi/langchain-core",
      "pkg:pypi/langchain-community",
    ]);
    expect(byId("ollama")?.purls).toEqual(["pkg:golang/github.com/ollama/ollama"]);
    expect(byId("flowise")?.purls).toEqual(["pkg:npm/flowise", "pkg:npm/flowise-components"]);
    expect(byId("llamaindex")?.purls).toEqual([
      "pkg:pypi/llama-index",
      "pkg:pypi/llama-index-core",
    ]);
  });

  it("keeps cve_build.py's coverage: package data for 9, commits only for llama.cpp, none for Dify and AnythingLLM", () => {
    const by = (coverage: Coverage) =>
      PATCH_FRAMEWORKS.filter((framework) => framework.coverage === coverage).map((f) => f.id);
    expect(by("commits")).toEqual(["llama.cpp"]);
    expect(by("none")).toEqual(["dify", "anything-llm"]);
    expect(by("package")).toHaveLength(9);
    for (const id of ["llama.cpp", "dify", "anything-llm"]) expect(byId(id)?.purls).toEqual([]);
  });
});
