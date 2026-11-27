// guard/permission-skip's corpus (#433): a few thousand hook commands, built by crossing the parts of the grammar
// `agentConfigCheck` reads (the agent's runs, the wrappers and `time`, wrapper option values named like shells, the
// shells by name and path, their `-c` option forms, the positions a command stands in, and nesting depth), each run
// through `see` as a settings file's one hook. Its places (count and kinds) are compared with the committed snapshot,
// `permission-skip-corpus.jsonl`, of what the code finds today. A change that drops a place or a kind from any command
// fails, naming the commands; so does one that adds places, listing them, until the snapshot is refreshed with
// `REFRESH_COMMAND` for the places the ticket asks for; the refresh itself refuses while a place, a kind or a command
// would be lost. The same file holds the 1 MiB worst-shape rows, sized to `ARCHIVE_LIMITS.fileBytes`. The flag and the
// mode are written `{FLAG}`, `{MODE}` and `{BYPASS}` in the corpus and the snapshot, and come joined from their parts
// (`test/agent-settings.ts`), so neither file holds a whole one for a Guard Scan of Warden's own repo to report.
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BYPASS, FLAG, hooks, MODE, see, settings, SKIP } from "../../../test/agent-settings.ts";
import { ARCHIVE_LIMITS } from "./tarball.ts";

const path = ".claude/settings.json";

/** Each placeholder the corpus and the snapshot write, with the text it stands for. */
const PLACEHOLDERS: readonly [placeholder: string, text: string][] = [
  ["{FLAG}", FLAG],
  ["{MODE}", MODE],
  ["{BYPASS}", BYPASS],
];
const fromPlaceholders = (text: string) =>
  PLACEHOLDERS.reduce((out, [placeholder, real]) => out.replaceAll(placeholder, real), text);
const toPlaceholders = (text: string) =>
  PLACEHOLDERS.reduce((out, [placeholder, real]) => out.replaceAll(real, placeholder), text);

/** A word in single quotes, a `'` in it closed, escaped and reopened. */
const sq = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/** A word in double quotes, as a shell reads it back: `"`, `\`, `$` and a backquote escaped. */
const dq = (text: string) => `"${text.replace(/["\\$`]/g, "\\$&")}"`;
const QUOTES = [sq, dq];

/** The agent's runs the corpus is built from: with the flag or the mode, by name, path or package, or skipping nothing. */
const RUNS = [
  "claude {FLAG}",
  "claude -p x {FLAG}",
  "claude {MODE} {BYPASS}",
  "claude {MODE}={BYPASS}",
  "claude '{FLAG}'",
  "/usr/local/bin/claude {FLAG}",
  "claude-code {FLAG}",
  'claude -p "use {FLAG}"',
  "claude -p x",
  "echo {FLAG}",
];

/** One run per kind, and one that skips nothing, for the crosses that would grow too large with every run. */
const CORE = ["claude {FLAG}", "claude {MODE} {BYPASS}", "claude -p x"];

const SHELLS = ["sh", "bash", "zsh", "dash"];
const SHELL_SPELLINGS = [...SHELLS, "/bin/sh", "/usr/bin/bash", "/usr/local/bin/zsh", "/bin/dash"];

/** The 12 wrappers, some with options and their values, then `time`: the reserved word and the program. */
const WRAPPERS = [
  "env",
  "env FOO=1",
  "env -i",
  "exec",
  "exec -a name",
  "command",
  "nohup",
  "nice",
  "nice -n 10",
  "timeout 60",
  "timeout -s KILL 60",
  "sudo",
  "sudo -u root",
  "xargs",
  "xargs -n 1",
  "npx",
  "npx -y",
  "bunx",
  "pnpm",
  "pnpm exec",
  "yarn",
  "yarn dlx",
  "time",
  "time -p",
  "time -p --",
  "/usr/bin/time",
  "/usr/bin/time -f %e",
  "/usr/bin/time -o out",
];

/** A wrapper's option whose value is named like a shell, so the shell isn't the wrapper's command word. */
const SHELL_VALUED = SHELLS.flatMap((shell) => [
  `env -C /bin/${shell}`,
  `exec -a ${shell}`,
  `sudo -u ${shell}`,
  `xargs -I ${shell}`,
  `npx -p ${shell}`,
  `bunx -p ${shell}`,
  `pnpm -C /bin/${shell}`,
  `yarn --cwd /bin/${shell}`,
  `/usr/bin/time -o ${shell}`,
]);

const PREFIXES = [...WRAPPERS, ...SHELL_VALUED];

/** The options that make a shell run its next word as a command string, with others before or after. */
const STRING_OPTIONS = [
  "-c",
  "-lc",
  "-ec",
  "-e -c",
  "-c --",
  "--login -c",
  "--norc -c",
  "-o pipefail -c",
  "+o posix -c",
  "-O extglob -c",
  "--rcfile x -c",
];

/** The places a command can stand in another: substitutions, after separators, in compound commands' bodies. */
const POSITIONS: readonly ((command: string) => string)[] = [
  (x) => x,
  (x) => `$(${x})`,
  (x) => `echo $(${x})`,
  (x) => `echo \`${x}\``,
  (x) => `cat <(${x})`,
  (x) => `tee >(${x})`,
  (x) => `x=$(${x})`,
  (x) => `echo "$(${x})"`,
  (x) => `echo a; ${x}`,
  (x) => `echo a && ${x}`,
  (x) => `false || ${x}`,
  (x) => `echo a | ${x}`,
  (x) => `${x} | cat`,
  (x) => `${x} &`,
  (x) => `echo a\n${x}`,
  (x) => `if true; then ${x}; fi`,
  (x) => `if ${x}; then :; fi`,
  (x) => `while true; do ${x}; done`,
  (x) => `{ ${x}; }`,
  (x) => `(${x})`,
  (x) => `f() { ${x}; }`,
  (x) => `FOO=1 ${x}`,
  (x) => `>out ${x}`,
  (x) => `! ${x}`,
  (x) => `# ${x}`,
  (x) => `echo ${sq(x)}`,
];

/** A shell's arguments that hold a run the shell executes before its own. */
const SHELL_ARGUMENTS: readonly ((command: string) => string)[] = [
  (x) => `script.sh $(${x})`,
  (x) => `-c 'echo' $(${x})`,
  (x) => `<(${x})`,
  (x) => `script.sh \`${x}\``,
  (x) => `-c "echo" \`${x}\``,
];

/** `run` inside `depth` shells' `-c` strings, the shells and quotes taken in turn from `first`, each after `prefix`. */
function nested(run: string, depth: number, first: number, prefix: string): string {
  let command = run;
  for (let level = 0; level < depth; level++) {
    const shell = SHELLS[(first + level) % SHELLS.length]!;
    const quote = QUOTES[(first + level) % QUOTES.length]!;
    command = `${prefix}${shell} -c ${quote(command)}`;
  }
  return command;
}

/** The corpus, in the order it is built: each group crosses some of the grammar's parts. */
function corpus(): string[] {
  const commands = new Set<string>();
  // The runs on their own, and after each wrapper or a wrapper option's value named like a shell.
  for (const run of RUNS) {
    commands.add(run);
    for (const prefix of PREFIXES) commands.add(`${prefix} ${run}`);
  }
  // A shell's -c string, by name and path, with each option form and both quotes.
  for (const run of CORE) {
    for (const shell of SHELL_SPELLINGS) {
      for (const options of STRING_OPTIONS) {
        for (const quote of QUOTES) commands.add(`${shell} ${options} ${quote(run)}`);
      }
    }
  }
  // A shell's -c string after each prefix, and the agent's word after a wrapped shell (a script named `claude`).
  for (const prefix of PREFIXES) {
    for (const run of CORE) commands.add(`${prefix} bash -c ${sq(run)}`);
    for (const shell of SHELLS) commands.add(`${prefix} ${shell} claude {FLAG}`);
  }
  // Each position, around a run, a wrapped run or a shell's string.
  const inner = [
    ...RUNS,
    "sudo claude {FLAG}",
    "env FOO=1 claude {FLAG}",
    "time claude {FLAG}",
    `bash -c ${sq("claude {FLAG}")}`,
    `sh -c ${dq("claude {MODE} {BYPASS}")}`,
  ];
  for (const position of POSITIONS) for (const run of inner) commands.add(position(run));
  // Each position inside a shell's -c string.
  for (const position of POSITIONS) {
    for (const run of CORE) {
      for (const shell of SHELLS) {
        for (const quote of QUOTES) commands.add(`${shell} -c ${quote(position(run))}`);
      }
    }
  }
  // A run among a shell's arguments, the shell by name or path, maybe wrapped.
  for (const prefix of ["", "env FOO=1 ", "sudo ", "time "]) {
    for (const shell of SHELL_SPELLINGS) {
      for (const args of SHELL_ARGUMENTS) {
        for (const run of CORE) commands.add(`${prefix}${shell} ${args(run)}`);
      }
    }
  }
  // Several places in one command: two runs after each separator, both kinds in one run, a run in a shell's string
  // beside one among its arguments, and a run after five script runs (which spend none of the shell budget).
  for (const separator of ["; ", " && ", " || ", " | ", " & ", "\n"]) {
    for (const first of CORE) for (const second of CORE) commands.add(first + separator + second);
  }
  commands.add("claude {FLAG} {MODE} {BYPASS}");
  for (const run of CORE) {
    commands.add(`bash -c ${sq(run)} $(${run})`);
    commands.add(`bash a.sh; bash b.sh; bash c.sh; bash d.sh; bash e.sh; ${run}`);
  }
  // Nesting depth: 1 to 6 shells, each maybe wrapped.
  for (const run of CORE) {
    for (let depth = 1; depth <= 6; depth++) {
      for (let first = 0; first < SHELLS.length; first++) {
        for (const prefix of ["", "sudo "]) commands.add(nested(run, depth, first, prefix));
      }
    }
  }
  return [...commands];
}

/** A command's places, as its Finding names them: how many, and their kinds in its order. */
type Places = { places: number; kinds: string[] };

/**
 * A Finding's summary: its count, then its kinds, joined by `, ` (the too-deep kind holds one itself), then maybe the
 * count and kinds of the places that may skip, worded apart from the ones that do.
 */
const SUMMARY = new RegExp(
  String.raw`^(\d+) places? (?:may )?skips? the agent's permission checks \((.*?)\)(?: and (\d+) more may \((.*?)\))? in ${path.replaceAll(".", "\\.")}, `,
);
const KIND = /[^,]*, nested too deep to check|[^,]+/g;

/** The places `agentConfigCheck` finds in a settings file whose one hook runs `template`, with its placeholders filled. */
function placesOf(template: string): Places {
  const found = see(path, settings({}, hooks("Stop", fromPlaceholders(template)))).filter(
    (observation) => observation.rule_id === SKIP,
  );
  if (found.length === 0) return { places: 0, kinds: [] };
  const summary = found[0]!.evidence.summary;
  const match = SUMMARY.exec(summary);
  if (found.length > 1 || match === null) {
    throw new Error(
      `Can't read the places of ${JSON.stringify(fromPlaceholders(template))}: ${summary}`,
    );
  }
  const [, count, kinds, mayCount = "0", mayKinds] = match;
  return {
    places: Number(count) + Number(mayCount),
    kinds: [kinds!, mayKinds ?? ""].flatMap((text) =>
      Array.from(text.matchAll(KIND), ([kind]) => toPlaceholders(kind.trim())),
    ),
  };
}

const SNAPSHOT = new URL("./permission-skip-corpus.jsonl", import.meta.url);
const REFRESH = "REFRESH_PERMISSION_SKIP_CORPUS";
/** The refresh, run with `vitest.corpus.config.ts`: this file alone, with no database to set up. */
const REFRESH_COMMAND = `${REFRESH}=1 pnpm --filter @warden/server exec vitest run --config vitest.corpus.config.ts`;

/** The snapshot's text: one command a line, as `[command, places, ...kinds]`, in the corpus's order. */
const snapshotText = (results: ReadonlyMap<string, Places>) =>
  [...results]
    .map(([command, { places, kinds }]) => `${JSON.stringify([command, places, ...kinds])}\n`)
    .join("");

function readSnapshot(): Map<string, Places> {
  let text: string;
  try {
    text = readFileSync(SNAPSHOT, "utf8");
  } catch {
    return new Map();
  }
  return new Map(
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [command, places, ...kinds] = JSON.parse(line) as [string, number, ...string[]];
        return [command, { places, kinds }];
      }),
  );
}

const shown = ({ places, kinds }: Places) =>
  places === 0 ? "0" : `${places} (${kinds.map(fromPlaceholders).join(", ")})`;

/** One line of a failure: the command as it runs, and its places in the snapshot and now. */
const changeLine = (command: string, was: Places, now: Places) =>
  `  ${JSON.stringify(fromPlaceholders(command))}: ${shown(was)} -> ${shown(now)}`;

const lostFrom = (was: Places, now: Places) =>
  now.places < was.places || was.kinds.some((kind) => !now.kinds.includes(kind));
const addedTo = (was: Places, now: Places) =>
  now.places > was.places || now.kinds.some((kind) => !was.kinds.includes(kind));

/** The lines of each command in both the snapshot and the corpus whose places changed one way. */
function changes(
  snapshot: ReadonlyMap<string, Places>,
  now: ReadonlyMap<string, Places>,
  changed: (was: Places, now: Places) => boolean,
): string[] {
  return [...now].flatMap(([command, places]) => {
    const was = snapshot.get(command);
    return was !== undefined && changed(was, places) ? [changeLine(command, was, places)] : [];
  });
}

/** The snapshot's commands the corpus no longer builds, each as it runs. */
const goneFrom = (snapshot: ReadonlyMap<string, Places>, now: ReadonlyMap<string, Places>) =>
  [...snapshot.keys()]
    .filter((command) => !now.has(command))
    .map((command) => `  ${JSON.stringify(fromPlaceholders(command))}`);

/** Why refreshing the snapshot with `now` would lose a place, a kind or a command it holds; nothing when it loses none. */
function refreshRefusal(
  snapshot: ReadonlyMap<string, Places>,
  now: ReadonlyMap<string, Places>,
): string | undefined {
  const lost = changes(snapshot, now, lostFrom);
  const gone = goneFrom(snapshot, now);
  if (lost.length === 0 && gone.length === 0) return undefined;
  return [
    "The snapshot isn't refreshed: it would lose what main finds. A change keeps every place, kind and command it holds.",
    "If the ticket drops these on purpose, edit or delete their lines in permission-skip-corpus.jsonl by hand, then refresh.",
    `Lost a place or a kind (${lost.length}, snapshot -> now):`,
    ...lost,
    `No longer in the corpus (${gone.length}):`,
    ...gone,
  ].join("\n");
}

describe("refreshing the corpus's snapshot", () => {
  const none: Places = { places: 0, kinds: [] };
  const flag: Places = { places: 1, kinds: ["{FLAG}"] };
  const snapshot = new Map([
    ["claude {FLAG}", flag],
    ["claude -p x", none],
    ["sh claude {FLAG}", flag],
  ]);

  it("goes ahead when every command keeps its places, though some gain one and new commands come in", () => {
    const now = new Map([
      ["claude {FLAG}", flag],
      ["claude -p x", flag],
      ["sh claude {FLAG}", flag],
      ["bash claude {FLAG}", flag],
    ]);

    expect(refreshRefusal(snapshot, now)).toBeUndefined();
  });

  it("refuses while a command loses a place or leaves the corpus, naming each as it runs", () => {
    const now = new Map([
      ["claude {FLAG}", none],
      ["claude -p x", flag],
    ]);

    const refusal = refreshRefusal(snapshot, now);

    expect(refusal).toContain(`  ${JSON.stringify(`claude ${FLAG}`)}: 1 (${FLAG}) -> 0`);
    expect(refusal).toContain(`  ${JSON.stringify(`sh claude ${FLAG}`)}`);
    expect(refusal).not.toContain("claude -p x");
  });
});

describe("guard/permission-skip's corpus of hook commands", () => {
  // Read in a hook, not the describe's body, so a command `placesOf` can't read fails these tests by name.
  let commands: string[] = [];
  let now = new Map<string, Places>();
  let snapshot = new Map<string, Places>();
  beforeAll(() => {
    commands = corpus();
    now = new Map(commands.map((command) => [command, placesOf(command)]));
    snapshot = readSnapshot();
  });

  it.runIf(process.env[REFRESH] === "1")(
    "refreshes the snapshot when it would lose no place, kind or command",
    () => {
      const refusal = refreshRefusal(snapshot, now);
      if (refusal !== undefined) expect.fail(refusal);

      writeFileSync(SNAPSHOT, snapshotText(now));
      snapshot = readSnapshot();
    },
  );

  it("holds at least 2,000 commands, the same ones as the snapshot", () => {
    const unsnapped = commands.filter((command) => !snapshot.has(command));
    const gone = goneFrom(snapshot, now);

    expect(commands.length).toBeGreaterThanOrEqual(2000);
    if (unsnapped.length > 0 || gone.length > 0) {
      expect.fail(
        [
          "The corpus and its snapshot hold different commands.",
          `New commands are added by refreshing the snapshot with ${REFRESH_COMMAND}; a dropped command's line is deleted from it by hand first.`,
          `Not in the snapshot (${unsnapped.length}):`,
          ...unsnapped.map((command) => `  ${JSON.stringify(fromPlaceholders(command))}`),
          `No longer in the corpus (${gone.length}):`,
          ...gone,
        ].join("\n"),
      );
    }
  });

  it("keeps every place and kind the snapshot holds for each command", () => {
    const lost = changes(snapshot, now, lostFrom);

    if (lost.length > 0) {
      expect.fail(
        [
          `${lost.length} of ${commands.length} commands lost a place or a kind (snapshot -> now). A change keeps every place main finds:`,
          ...lost,
        ].join("\n"),
      );
    }
  });

  it("adds no place or kind the snapshot lacks", () => {
    const added = changes(snapshot, now, addedTo);

    if (added.length > 0) {
      expect.fail(
        [
          `${added.length} of ${commands.length} commands gained a place or a kind (snapshot -> now).`,
          `If the ticket asks for these places, refresh the snapshot with ${REFRESH_COMMAND}, and commit its diff:`,
          ...added,
        ].join("\n"),
      );
    }
  });
});

describe("guard/permission-skip on a 1 MiB hook", () => {
  /** A settings file of at most `ARCHIVE_LIMITS.fileBytes` whose one hook is `head`, `unit` repeated, then `tail`. */
  const filled = (head: string, unit: string, tail: string) => {
    const base = settings({}, hooks("Stop", head + tail)).length;
    const units = Math.floor((ARCHIVE_LIMITS.fileBytes - base) / unitBytes(unit));
    return settings({}, hooks("Stop", head + unit.repeat(units) + tail));
  };
  /** `head`, `first` repeated to fill about half of `ARCHIVE_LIMITS.fileBytes`, then `second` to fill the rest. */
  const halves = (first: string, second: string, head = "") => {
    const units = Math.floor(ARCHIVE_LIMITS.fileBytes / 2 / unitBytes(first));
    return filled(head + first.repeat(units), second, "");
  };
  /** How many characters one more `unit` adds to a settings file's hook, its JSON escapes included. */
  const unitBytes = (unit: string) =>
    settings({}, hooks("Stop", unit)).length - settings({}, hooks("Stop", "")).length;

  // On a laptop, main's parser read each of the first four in 25–55 ms and the fifth in 30–110 ms, where a read per
  // shell's name took minutes; a parser that scanned again from the start for each run or backquote took seconds to
  // minutes on the rest. The limit leaves room for a slow CI runner. A row with a kind also checks its Finding names it.
  it.each<[name: string, text: string, kind?: string]>([
    ["a wrapper then shells' names", filled("sudo ", "bash ", `claude ${FLAG}`)],
    ["a wrapper then shells' -c strings", filled("sudo ", `bash "-c" 'x' `, `claude ${FLAG}`)],
    ["shells after separators", filled("", "bash x;", "")],
    ["shells' strings opening substitutions", filled("", `bash -c "$(`, "")],
    ["a shell's string of quotes and escapes", filled("bash -c '' ", `'a' "b\\"" \\x `, "")],
    ["agent runs after separators", filled("", "claude x;", "")],
    ["agent runs with the flag after separators", filled("", `claude ${FLAG};`, ""), FLAG],
    ["(s then backquotes", halves("(", "`")],
    ["$(s then backquotes", halves("$(", "`")],
    ["a backquote, (s, then escaped backquotes", halves("(", "\\`", "`")],
    ["an unclosed backquote then agent runs", filled("`", "claude x;", "")],
  ])("reads a 1 MiB hook of %s within a second", (_name, text, kind) => {
    const started = performance.now();
    const observations = see(path, text);

    expect(performance.now() - started).toBeLessThan(1000);
    if (kind !== undefined) {
      expect(observations).toEqual([
        expect.objectContaining({
          rule_id: SKIP,
          evidence: {
            summary: expect.stringContaining(`skip the agent's permission checks (${kind})`),
          },
        }),
      ]);
    }
  });

  it.each([
    ["an unclosed backquote", filled("`", "claude x;", "")],
    ["an unclosed (", filled("(", "claude x;", "")],
    ["a trailing backslash", filled("", "claude x;", "\\")],
  ])("gives nothing for a 1 MiB hook of agent runs after %s, and doesn't throw", (_name, text) => {
    expect(see(path, text)).toEqual([]);
  });
});
