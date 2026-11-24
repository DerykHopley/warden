import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const MODULE_IMPORT_MESSAGE =
  "shared code never imports a module (ADR 0005): wire Guard, Patch and Vouch in server/src/index.ts";
/** The ADR 0005 pattern, `(^|/)modules(/|$)`, as an esquery regex. */
const MODULES_PATH = String.raw`/(^|\/)modules(\/|$)/`;

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["server/**/*.ts", "contracts/**/*.ts", "*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // The dashboard bundles contracts' main entry point, so only the Node-only subpath loader may use Node.
    files: ["contracts/src/**/*.ts"],
    ignores: ["contracts/src/reconcile-cases.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "fs/*",
                "path",
                "url",
                "os",
                "crypto",
                "child_process",
                "module",
              ],
              message:
                "contracts' main entry point runs in the browser too: keep Node code in src/reconcile-cases.ts",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["process", "Buffer", "require", "__dirname", "__filename"].map((name) => ({
          name,
          message: "contracts' main entry point runs in the browser too",
        })),
      ],
    },
  },
  {
    // ADR 0005: Guard, Patch and Vouch import the shared code, never the other way. The start-up files wire the
    // modules in (the server's, and the demo seed's, which reconciles as the server does), and tests may import them
    // as they do. A dynamic import() counts too, when its specifier is a string or a template literal naming a
    // modules path.
    files: ["server/src/**/*.ts"],
    ignores: [
      "server/src/modules/**",
      "server/src/index.ts",
      "server/src/seed.ts",
      "server/src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)modules(/|$)",
              message: MODULE_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression > Literal.source[value=${MODULES_PATH}]`,
          message: MODULE_IMPORT_MESSAGE,
        },
        {
          selector: `ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=${MODULES_PATH}]`,
          message: MODULE_IMPORT_MESSAGE,
        },
      ],
    },
  },
  {
    files: ["dashboard/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
