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
  /** One Observation per other AI tool whose config the repo holds, in the order of `AI_TOOLS`; none for no tool. */
  end(): Observation[];
}

/** Where a path shows a tool: the folder it sits under, or the file itself. Undefined for a path that doesn't. */
type Signal = (path: string) => string | undefined;

/** A folder of this name in any folder, for a file anywhere under it: located at the folder, the outermost one. */
const folderAnywhere =
  (name: string): Signal =>
  (path) => {
    const parts = path.split("/");
    const at = parts.indexOf(name);
    return at >= 0 && at < parts.length - 1 ? parts.slice(0, at + 1).join("/") : undefined;
  };

/** A file whose name passes `named`, in any folder. */
const fileAnywhere =
  (named: (name: string) => boolean): Signal =>
  (path) =>
    named(path.slice(path.lastIndexOf("/") + 1)) ? path : undefined;

/** A folder at the repo root, for a file anywhere under it. */
const rootFolder =
  (folder: string): Signal =>
  (path) =>
    path.startsWith(`${folder}/`) ? folder : undefined;

/** A file at the repo root. */
const rootFile =
  (file: string): Signal =>
  (path) =>
    path === file ? path : undefined;

const fileNamed = (file: string) => fileAnywhere((name) => name === file);

/** The other AI tools, each with the paths that show it, matched case-sensitively; a folder before a file. */
const AI_TOOLS: readonly { tool: string; signals: readonly Signal[] }[] = [
  { tool: "Cursor", signals: [folderAnywhere(".cursor"), fileNamed(".cursorrules")] },
  { tool: "Windsurf", signals: [folderAnywhere(".windsurf"), fileNamed(".windsurfrules")] },
  {
    tool: "GitHub Copilot",
    // GitHub reads both only at the repo root.
    signals: [rootFolder(".github/instructions"), rootFile(".github/copilot-instructions.md")],
  },
  { tool: "Gemini CLI", signals: [folderAnywhere(".gemini"), fileNamed("GEMINI.md")] },
  // `.aider.conf.yml`, `.aiderignore`, `.aider.chat.history.md` and the rest of Aider's files.
  { tool: "Aider", signals: [fileAnywhere((name) => name.startsWith(".aider"))] },
  { tool: "Continue", signals: [folderAnywhere(".continue")] },
  { tool: "Cline", signals: [fileNamed(".clinerules")] },
];

export function aiToolCheck(asset: Asset): AiToolCheck {
  /** Each tool's matched paths, each with where it shows the tool. */
  const found = AI_TOOLS.map(() => [] as { path: string; at: string }[]);
  return {
    see(path) {
      AI_TOOLS.forEach(({ signals }, i) => {
        const at = signals.map((signal) => signal(path)).find((where) => where !== undefined);
        if (at !== undefined) found[i]!.push({ path, at });
      });
    },
    end() {
      const rule = packRule(UNAPPROVED_AI_TOOL);
      return AI_TOOLS.flatMap(({ tool }, i): Observation[] => {
        // Sorted by code unit, not locale, so the location and the names don't change with the server's settings.
        const matched = found[i]!.toSorted((a, b) => (a.path < b.path ? -1 : 1));
        const [first] = matched;
        if (first === undefined) return [];
        const count = matched.length;
        const paths = summaryNames(matched.map(({ path }) => path));
        return [
          {
            asset,
            rule_id: rule.ruleId,
            location: { kind: "file", path: first.at },
            severity: rule.severity,
            title: rule.title,
            evidence: {
              summary: `${tool} config in ${count} ${count === 1 ? "path" : "paths"} (${paths}). Claude Code is the only approved AI tool. To fix: ${rule.fix}`,
            },
          },
        ];
      });
    },
  };
}
