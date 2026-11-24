// ADR 0005's import rule, through ESLint's Node API on the repo's own config: shared code never imports a module, by
// a static import or a dynamic import(). The start-up file wires the modules in, so it may.
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

  it.each(Object.entries(dynamicImports))(
    "lets the start-up file import() a module, with %s",
    async (_name, code) => {
      expect(await lint(code, "server/src/index.ts")).toEqual([]);
    },
  );

  it("lets shared code import() anything else", async () => {
    expect(
      await lint('await import("./findings/index.ts");\nexport {};\n', "server/src/x.ts"),
    ).toEqual([]);
  });
});
