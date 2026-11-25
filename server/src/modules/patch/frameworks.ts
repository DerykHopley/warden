/**
 * The frameworks Patch knows (the spec's "catalogue"; "frameworks" here, since the glossary's Catalogue is a set of
 * Controls): fixed data, ported from Patch's cve_build.py, its PRODUCTS (id and display name) and PACKAGES (OSV
 * packages and coverage) as checked on 2026-10-14. Each package is a purl without a version: `pkg:pypi/<name>`,
 * `pkg:npm/<name>`, `pkg:golang/<module path>`.
 */
import type { Framework } from "@warden/contracts";

export const PATCH_FRAMEWORKS: readonly Framework[] = [
  { id: "langflow", name: "Langflow", purls: ["pkg:pypi/langflow"], coverage: "package" },
  { id: "open-webui", name: "Open WebUI", purls: ["pkg:pypi/open-webui"], coverage: "package" },
  {
    id: "flowise",
    name: "Flowise",
    purls: ["pkg:npm/flowise", "pkg:npm/flowise-components"],
    coverage: "package",
  },
  { id: "vllm", name: "vLLM", purls: ["pkg:pypi/vllm"], coverage: "package" },
  {
    id: "langchain",
    name: "LangChain",
    purls: ["pkg:pypi/langchain", "pkg:pypi/langchain-core", "pkg:pypi/langchain-community"],
    coverage: "package",
  },
  { id: "gradio", name: "Gradio", purls: ["pkg:pypi/gradio"], coverage: "package" },
  { id: "litellm", name: "LiteLLM", purls: ["pkg:pypi/litellm"], coverage: "package" },
  {
    id: "ollama",
    name: "Ollama",
    purls: ["pkg:golang/github.com/ollama/ollama"],
    coverage: "package",
  },
  {
    id: "llamaindex",
    name: "LlamaIndex",
    purls: ["pkg:pypi/llama-index", "pkg:pypi/llama-index-core"],
    coverage: "package",
  },
  // OSV has git commit ranges only for llama.cpp, and nothing for Dify or AnythingLLM.
  { id: "llama.cpp", name: "llama.cpp", purls: [], coverage: "commits" },
  { id: "dify", name: "Dify", purls: [], coverage: "none" },
  { id: "anything-llm", name: "AnythingLLM", purls: [], coverage: "none" },
];
