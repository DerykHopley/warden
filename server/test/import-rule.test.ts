// ADR 0005's import rule, through ESLint's Node API on the repo's own config: shared code never imports a module, by
// a static import or a dynamic import(). The wiring and the start-up files wire the modules in, so they may.
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });
const ADR_0005 = /shared code never imports a module \(ADR 0005\)/;

/** The messages ESLint gives `code` as if it were the file at `filePath`, relative to the repo. */
async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((message) => message.message);
}

const dynamicImports = {
  "a string": 'await import("./modules/guard/move-rule.ts");\nexport {};\n',
  "a template literal": "await import(`./modules/guard/move-rule.ts`);\nexport {};\n",
};

const LITERAL_PATHS_ONLY = /shared code imports by a literal path only \(ADR 0005\)/;

const computedImports = {
  "a variable": 'const name = "./findings/index.ts";\nawait import(name);\nexport {};\n',
  "a concatenated string": 'await import("./mod" + "ules/x.ts");\nexport {};\n',
  "a template literal with an expression":
    'const x = "findings/index.ts";\nawait import(`./${x}`);\nexport {};\n',
};

const createRequires = {
  "a named import": [
    'import { createRequire } from "node:module";',
    "const load = createRequire(import.meta.url);",
    'load("./findings/index.ts");',
    "",
  ].join("\n"),
  "a namespace import": [
    'import * as nodeModule from "node:module";',
    'nodeModule.createRequire(import.meta.url)("./findings/index.ts");',
    "",
  ].join("\n"),
};

describe("ADR 0005's import rule", () => {
  it.each(Object.entries(dynamicImports))(
    "refuses a dynamic import() of a module from shared code, with %s",
    async (_name, code) => {
      expect(await lint(code, "server/src/findings/loader.ts")).toEqual([
        expect.stringMatching(ADR_0005),
      ]);
    },
  );

  it("refuses a static import of a module from shared code, as before", async () => {
    const code =
      'import { guardMoveRule } from "./modules/guard/move-rule.ts";\nvoid guardMoveRule;\n';
    expect(await lint(code, "server/src/shared.ts")).toEqual([expect.stringMatching(ADR_0005)]);
  });

  it("points a refused import at the wiring, where the modules are wired in", async () => {
    const code =
      'import { guardMoveRule } from "./modules/guard/move-rule.ts";\nvoid guardMoveRule;\n';
    const [message] = await lint(code, "server/src/shared.ts");
    expect(message).toContain("server/src/wiring.ts");
    expect(message).not.toContain("in server/src/index.ts");
  });

  it.each(Object.entries(dynamicImports))(
    "lets the start-up file import() a module, with %s",
    async (_name, code) => {
      expect(await lint(code, "server/src/index.ts")).toEqual([]);
    },
  );

  it("lets the demo seed's start-up file import a module, as the server's does", async () => {
    const code =
      'import { guardMoveRule } from "./modules/guard/move-rule.ts";\nvoid guardMoveRule;\n';
    expect(await lint(code, "server/src/seed.ts")).toEqual([]);
  });

  it("lets the wiring the start-up files share import a module, and not the Scan Job or its shared code", async () => {
    const code =
      'import { guardMoveRule } from "./modules/guard/move-rule.ts";\nvoid guardMoveRule;\n';
    expect(await lint(code, "server/src/wiring.ts")).toEqual([]);
    for (const shared of ["scan-job.ts", "scans.ts", "local-scan-job-starter.ts"]) {
      expect(await lint(code, `server/src/${shared}`)).toEqual([expect.stringMatching(ADR_0005)]);
    }
  });

  it("lets the daily Job's start-up file import a module, and another shared file still may not", async () => {
    const code =
      'import { createPatchRefresh } from "./modules/patch/refresh.ts";\nvoid createPatchRefresh;\n';
    expect(await lint(code, "server/src/daily-expiry.ts")).toEqual([]);
    expect(await lint(code, "server/src/shared.ts")).toEqual([expect.stringMatching(ADR_0005)]);
  });

  it("lets shared code import() anything else", async () => {
    expect(
      await lint('await import("./findings/index.ts");\nexport {};\n', "server/src/x.ts"),
    ).toEqual([]);
    expect(
      await lint("await import(`./findings/index.ts`);\nexport {};\n", "server/src/x.ts"),
    ).toEqual([]);
  });

  // A lint rule can't follow a variable, so shared code may only import() by a literal path, and never createRequire.
  it.each(Object.entries(computedImports))(
    "refuses a computed import() in shared code, with %s",
    async (_name, code) => {
      expect(await lint(code, "server/src/findings/loader.ts")).toEqual([
        expect.stringMatching(LITERAL_PATHS_ONLY),
      ]);
    },
  );

  it.each(Object.entries(createRequires))(
    "refuses createRequire in shared code, with %s",
    async (_name, code) => {
      const messages = await lint(code, "server/src/findings/loader.ts");
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) expect(message).toMatch(LITERAL_PATHS_ONLY);
    },
  );

  it.each([
    "server/src/modules/guard/loader.ts",
    "server/src/index.ts",
    "server/src/seed.ts",
    "server/src/findings/loader.test.ts",
  ])("lets %s import() by a computed path and use createRequire", async (filePath) => {
    for (const code of [...Object.values(computedImports), ...Object.values(createRequires)]) {
      expect(await lint(code, filePath)).toEqual([]);
    }
  });
});
