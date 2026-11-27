// Claude Code settings files for Guard's agent-config tests, and `see` to read one as a repo's file. The flag and the
// mode are built here by joining their parts, so this file never holds a whole one for a Guard Scan of Warden's own
// repo to report.
import type { Asset } from "@warden/contracts";
import { agentConfigCheck } from "../src/modules/guard/agent-config.ts";

export const repo: Asset = { kind: "repo", ref: "https://github.com/example/app" };

export const SKIP = "guard/permission-skip";

export const join = (...parts: string[]) => parts.join("");
/** The flag that starts Claude Code with its permission checks off. */
export const FLAG = join("--dangerously", "-skip-permissions");
export const MODE = join("--permission", "-mode");
export const BYPASS = join("bypass", "Permissions");

/** A settings file's text, pretty-printed as Claude Code writes it: each allow entry on a line of its own. */
export const settings = (
  permissions: Record<string, unknown>,
  rest: Record<string, unknown> = {},
) =>
  `${JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", permissions, ...rest }, null, 2)}\n`;

/** A settings file's `hooks` key: one matcher group under `event`, holding one command hook. */
export const hooks = (event: string, command: string) => ({
  hooks: { [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
});

/** The Observations `agentConfigCheck` answers for one file of `repo`. */
export const see = (path: string, text: string) => agentConfigCheck(repo).see({ path, text });
