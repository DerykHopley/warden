// Guard's other-AI-tool Rule (Guard spec, stories 3 and 4): `aiToolCheck(asset)` takes each of a repo's file paths,
// read or unread, and answers one Observation per AI tool other than Claude Code whose config the repo holds, located
// at the tool's first signal with no line.
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
    ["Cursor", ".cursorrules", ".cursorrules"],
    ["Windsurf", ".windsurf/rules/a.md", ".windsurf"],
    ["Windsurf", ".windsurfrules", ".windsurfrules"],
    ["GitHub Copilot", ".github/instructions/ts.instructions.md", ".github/instructions"],
    ["GitHub Copilot", ".github/copilot-instructions.md", ".github/copilot-instructions.md"],
    ["Gemini CLI", ".gemini/settings.json", ".gemini"],
    ["Gemini CLI", "GEMINI.md", "GEMINI.md"],
    ["Gemini CLI", "docs/GEMINI.md", "docs/GEMINI.md"],
    ["Aider", ".aider.conf.yml", ".aider.conf.yml"],
    ["Aider", ".aiderignore", ".aiderignore"],
    ["Aider", "app/.aider.chat.history.md", "app/.aider.chat.history.md"],
    ["Continue", ".continue/config.yaml", ".continue"],
    ["Cline", ".clinerules", ".clinerules"],
  ])("gives one %s Observation for %s, located at %s with no line", (tool, path, at) => {
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
  });

  it("gives one Observation per tool, at its first signal in sorted order, counting each of its paths", () => {
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
      { rule_id: RULE, location: { kind: "file", path: ".cursorrules" } },
      { rule_id: RULE, location: { kind: "file", path: ".windsurf" } },
    ]);
  });

  it("locates a folder signal in a subfolder at the folder, which a second file under it doesn't move", () => {
    const one = observe(["apps/web/.cursor/rules/a.mdc"]);
    const two = observe(["apps/web/.cursor/rules/a.mdc", "apps/web/.cursor/rules/0.mdc"]);

    expect(one[0]?.location).toEqual({ kind: "file", path: "apps/web/.cursor" });
    expect(two[0]?.location).toEqual({ kind: "file", path: "apps/web/.cursor" });
  });

  it.each([
    [".cursor/.cursorrules", ".cursor"],
    [".gemini/GEMINI.md", ".gemini"],
  ])("locates %s, which both a folder and a file signal match, at the folder", (path, at) => {
    expect(observe([path])[0]?.location).toEqual({ kind: "file", path: at });
  });

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
