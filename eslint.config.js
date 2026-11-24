import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

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
    // ADR 0005: Guard, Patch and Vouch import the shared code, never the other way. The start-up file wires the
    // modules in, and tests may import them as it does.
    files: ["server/src/**/*.ts"],
    ignores: ["server/src/modules/**", "server/src/index.ts", "server/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)modules(/|$)",
              message:
                "shared code never imports a module (ADR 0005): wire Guard, Patch and Vouch in server/src/index.ts",
            },
          ],
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
