// Guard's other-AI-tool Rule (Guard spec, story 3): a repo that holds the config of an AI tool other than Claude Code,
// the only approved one (spec, question 8). A tool shows by its paths alone, so the Rule reads no file's text, and a file
// the reader couldn't read counts as much as one it could. `AGENTS.md` isn't a sign of any one tool, as several share
// it, Claude Code users among them; Claude Code's own paths never are either.
import type { Asset, Observation } from "@warden/contracts";
import { packRule, UNAPPROVED_AI_TOOL } from "./default-pack.ts";
import { summaryNames } from "./summary.ts";

/**
 * A repo's other-AI-tool check, made once per repo: `see` takes each of its file paths in turn, read or unread, and
 * `end` answers once all of them have been through.
 */
export interface AiToolCheck {
  see(path: string): void;
  /**
   * One Observation per other AI tool whose config the repo holds, at the tool's fixed Location, in the order of
   * `AI_TOOLS`; none for no tool.
   */
  end(): Observation[];
}

/** Whether a path shows a tool. */
type Signal = (path: string) => boolean;

/** A folder of this name in any folder, for a file anywhere under it. */
const folderAnywhere =
  (name: string): Signal =>
  (path) =>
    path.split("/").slice(0, -1).includes(name);

/** A file whose name passes `named`, in any folder. */
const fileAnywhere =
  (named: (name: string) => boolean): Signal =>
  (path) =>
    named(path.slice(path.lastIndexOf("/") + 1));

/** A folder at the repo root, for a file anywhere under it. */
const rootFolder =
  (folder: string): Signal =>
  (path) =>
    path.startsWith(`${folder}/`);

/** A file at the repo root. */
const rootFile =
  (file: string): Signal =>
  (path) =>
    path === file;

const fileNamed = (file: string) => fileAnywhere((name) => name === file);

/**
 * The other AI tools, each with the paths that show it, matched case-sensitively, and `at`, the one fixed Location its
 * Finding sits at, whichever of those paths the repo holds and at whatever depth. So while any of a tool's config stays,
 * its Finding keeps its Fingerprint, and with it its id and Status, across Scans; only removing the last of its paths
 * marks it Fixed. Like the whole-repo Rules' `WHOLE_REPO_PATH`, the Location is where the problem is reported, and the
 * evidence summary names the real paths. For a tool with both a folder and a file, `at` is the folder, the Location a
 * repo holding both at its root always had; Aider's is its config file.
 */
const AI_TOOLS: readonly { tool: string; at: string; signals: readonly Signal[] }[] = [
  {
    tool: "Cursor",
    at: ".cursor",
    signals: [folderAnywhere(".cursor"), fileNamed(".cursorrules")],
  },
  {
    tool: "Windsurf",
    at: ".windsurf",
    signals: [folderAnywhere(".windsurf"), fileNamed(".windsurfrules")],
  },
  {
    tool: "GitHub Copilot",
    at: ".github/copilot-instructions.md",
    // GitHub reads both only at the repo root.
    signals: [rootFolder(".github/instructions"), rootFile(".github/copilot-instructions.md")],
  },
  {
    tool: "Gemini CLI",
    at: ".gemini",
    signals: [folderAnywhere(".gemini"), fileNamed("GEMINI.md")],
  },
  // `.aider.conf.yml`, `.aiderignore`, `.aider.chat.history.md` and the rest of Aider's files.
  {
    tool: "Aider",
    at: ".aider.conf.yml",
    signals: [fileAnywhere((name) => name.startsWith(".aider"))],
  },
  { tool: "Continue", at: ".continue", signals: [folderAnywhere(".continue")] },
  { tool: "Cline", at: ".clinerules", signals: [fileNamed(".clinerules")] },
];

/** Each tool's fixed Location, which a repo holding only the tool's other paths doesn't hold. */
export const AI_TOOL_LOCATIONS: readonly string[] = AI_TOOLS.map(({ at }) => at);

/**
 * The other-AI-tool check for one repo. Each tool's Observation sits at the tool's fixed Location rather than at any one
 * of its paths, so adding or removing one of several paths doesn't move it: one Location while any of its config stays.
 * A path that more than one of a tool's signals match (`.cursor/.cursorrules`) counts once.
 */
export function aiToolCheck(asset: Asset): AiToolCheck {
  /** Each tool with the paths that show it. */
  const tools = AI_TOOLS.map(({ tool, at, signals }) => ({
    tool,
    at,
    signals,
    matched: [] as string[],
  }));
  return {
    see(path) {
      for (const { signals, matched } of tools) {
        if (signals.some((signal) => signal(path))) matched.push(path);
      }
    },
    end() {
      const rule = packRule(UNAPPROVED_AI_TOOL);
      return tools.flatMap(({ tool, at, matched: seen }): Observation[] => {
        if (seen.length === 0) return [];
        // Sorted by code unit, not locale, so the names don't change with the server's settings.
        const matched = seen.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const count = matched.length;
        return [
          {
            asset,
            rule_id: rule.ruleId,
            location: { kind: "file", path: at },
            severity: rule.severity,
            title: rule.title,
            evidence: {
              summary: `${tool} config in ${count} ${count === 1 ? "path" : "paths"} (${summaryNames(matched)}). Claude Code is the only approved AI tool. To fix: ${rule.fix}`,
            },
          },
        ];
      });
    },
  };
}
