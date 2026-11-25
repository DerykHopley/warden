import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/** The browser tests' stand-in for @clerk/react: only the `e2e` mode builds it in. */
const clerkStandIn = fileURLToPath(new URL("./e2e/clerk-stand-in.tsx", import.meta.url));

export default defineConfig(({ mode }) => {
  // Clerk's publishable key is public by design and goes into the built page. A build without it would load a
  // dashboard that can't sign anyone in, so it stops here instead. Tests stub Clerk and need no key; so does the
  // `e2e` mode, which builds the browser tests' stand-in in Clerk's place.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const standIn = mode === "e2e";
  if (mode !== "test" && !standIn && !env.VITE_CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY is not set. Run `direnv allow` (it reads the key from the keyring), " +
        "or pass it as a build argument.",
    );
  }
  return {
    plugins: [react()],
    resolve: standIn ? { alias: [{ find: /^@clerk\/react$/, replacement: clerkStandIn }] } : {},
    server: {
      // In development Vite serves the dashboard and hands /api to the server.
      proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? "8080"}` },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
    },
  };
});
