// Guard's other-AI-tool Rule (Guard spec, stories 3 and 4): `aiToolCheck(asset)` takes each of a repo's file paths,
// read or unread, and answers one Observation per AI tool other than Claude Code whose config the repo holds, located
// at the tool's fixed Location with no line, whichever of its paths the repo holds.
import { Observation, type Asset } from "@warden/contracts";
import { describe, expect, it } from "vitest";
import { aiToolCheck } from "./ai-tools.ts";
import { packRule } from "./default-pack.ts";

const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

const RULE = "guard/unapproved-ai-tool";

/** What the check answers for a repo holding these paths. */
const observe = (paths: readonly string[]) => {
  const check = aiToolCheck(repo);
  for (const path of paths) check.see(path);
  return check.end();
};

describe("aiToolCheck", () => {
  it.each([
    ["Cursor", ".cursor/rules/a.mdc", ".cursor"],
    ["Cursor", "apps/web/.cursor/rules/a.mdc", ".cursor"],
    ["Cursor", ".cursorrules", ".cursor"],
    ["Windsurf", ".windsurf/rules/a.md", ".windsurf"],
    ["Windsurf", ".windsurfrules", ".windsurf"],
    [
      "GitHub Copilot",
      ".github/instructions/ts.instructions.md",
      ".github/copilot-instructions.md",
    ],
    ["GitHub Copilot", ".github/copilot-instructions.md", ".github/copilot-instructions.md"],
    ["Gemini CLI", ".gemini/settings.json", ".gemini"],
    ["Gemini CLI", "GEMINI.md", ".gemini"],
    ["Gemini CLI", "docs/GEMINI.md", ".gemini"],
    ["Aider", ".aider.conf.yml", ".aider.conf.yml"],
    ["Aider", ".aiderignore", ".aider.conf.yml"],
    ["Aider", "app/.aider.chat.history.md", ".aider.conf.yml"],
    ["Continue", ".continue/config.yaml", ".continue"],
    ["Cline", ".clinerules", ".clinerules"],
  ])(
    "gives one %s Observation for %s, located at the tool's fixed %s with no line",
    (tool, path, at) => {
      const rule = packRule(RULE);

      expect(observe([path])).toEqual([
        {
          asset: repo,
          rule_id: RULE,
          location: { kind: "file", path: at },
          severity: "medium",
          title: rule.title,
          evidence: {
            summary: `${tool} config in 1 path (${path}). Claude Code is the only approved AI tool. To fix: ${rule.fix}`,
          },
        },
      ]);
    },
  );

  it.each([
    ["Cursor", ".cursorrules", ".cursor/rules/a.mdc", ".cursor"],
    ["Windsurf", ".windsurfrules", ".windsurf/rules/a.md", ".windsurf"],
    [
      "GitHub Copilot",
      ".github/copilot-instructions.md",
      ".github/instructions/ts.instructions.md",
      ".github/copilot-instructions.md",
    ],
    ["Gemini CLI", "GEMINI.md", ".gemini/settings.json", ".gemini"],
    ["Aider", ".aiderignore", ".aider.conf.yml", ".aider.conf.yml"],
  ])(
    "keeps %s at one Location whichever of its paths the repo holds: %s, both, or %s",
    (_, one, other, at) => {
      const locations = [[one], [one, other], [other]].map((paths) =>
        observe(paths).map(({ location }) => location),
      );

      expect(locations).toEqual([
        [{ kind: "file", path: at }],
        [{ kind: "file", path: at }],
        [{ kind: "file", path: at }],
      ]);
    },
  );

  it("gives one Observation per tool, at its fixed Location, counting each of its paths", () => {
    const [cursor, ...rest] = observe([
      ".cursorrules",
      ".cursor/rules/b.mdc",
      ".cursor/rules/a.mdc",
    ]);

    expect(rest).toEqual([]);
    expect(cursor?.location).toEqual({ kind: "file", path: ".cursor" });
    expect(cursor?.evidence.summary).toBe(
      `Cursor config in 3 paths (.cursor/rules/a.mdc, .cursor/rules/b.mdc, .cursorrules). Claude Code is the only approved AI tool. To fix: ${packRule(RULE).fix}`,
    );
  });

  it("names the first three paths and counts the rest", () => {
    const [cursor] = observe(["a", "b", "c", "d", "e"].map((name) => `.cursor/rules/${name}.mdc`));

    expect(cursor?.evidence.summary).toContain(
      "Cursor config in 5 paths (.cursor/rules/a.mdc, .cursor/rules/b.mdc, .cursor/rules/c.mdc and 2 more).",
    );
  });

  it("gives one Observation for each tool the repo holds", () => {
    const found = observe([".cursorrules", "src/index.ts", ".windsurf/rules/a.md"]);

    expect(found.map(({ rule_id, location }) => ({ rule_id, location }))).toEqual([
      { rule_id: RULE, location: { kind: "file", path: ".cursor" } },
      { rule_id: RULE, location: { kind: "file", path: ".windsurf" } },
    ]);
  });

  it("keeps a tool's folder in a subfolder at the same Location when a root folder of it is added", () => {
    const nested = observe(["apps/web/.cursor/rules/a.mdc"]);
    const both = observe(["apps/web/.cursor/rules/a.mdc", ".cursor/rules/a.mdc"]);

    expect(nested.map(({ location }) => location)).toEqual([{ kind: "file", path: ".cursor" }]);
    expect(both.map(({ location }) => location)).toEqual([{ kind: "file", path: ".cursor" }]);
  });

  it.each([
    ["Cursor", ".cursor/.cursorrules", ".cursor"],
    ["Gemini CLI", ".gemini/GEMINI.md", ".gemini"],
  ])(
    "counts %s's %s, which both a folder and a file signal match, once at %s",
    (tool, path, at) => {
      const found = observe([path]);

      expect(found.map(({ location }) => location)).toEqual([{ kind: "file", path: at }]);
      expect(found[0]?.evidence.summary).toContain(`${tool} config in 1 path (${path}).`);
    },
  );

  it.each([
    ["AGENTS.md alone", ["AGENTS.md"]],
    ["Claude Code's own paths", [".claude/settings.json", "CLAUDE.md", ".mcp.json"]],
    ["a Copilot file outside the repo root", ["docs/.github/copilot-instructions.md"]],
    ["Copilot instructions outside the repo root", ["docs/.github/instructions/a.md"]],
    ["a source file named after a tool", ["src/cursor.ts"]],
    ["a signal in the wrong case", [".CURSORRULES"]],
    ["a name a signal only starts", [".cursorrules.bak", ".clinerules-old", "my.aider.conf.yml"]],
  ])("gives nothing for %s", (_, paths) => {
    expect(observe(paths)).toEqual([]);
  });

  it("counts a file the reader couldn't read by its path alone, as the Rule reads no file's text", () => {
    const [windsurf] = observe([".windsurf/workflows/large.bin"]);

    expect(windsurf?.location).toEqual({ kind: "file", path: ".windsurf" });
  });

  it("gives nothing for a repo with no other tool's config", () => {
    expect(observe([])).toEqual([]);
  });

  it("cuts each long path its summary names to 64 characters, so the Observation still parses", () => {
    const paths = ["a", "b", "c"].map((name) => `.cursor/rules/${name.repeat(990)}.mdc`);

    const [cursor] = observe(paths);

    expect(Observation.safeParse(cursor).success).toBe(true);
    for (const path of paths) {
      expect(cursor?.evidence.summary).not.toContain(path);
      expect(cursor?.evidence.summary).toContain(`${path.slice(0, 63)}…`);
    }
  });
});
