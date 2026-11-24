import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Clerk's publishable key is public by design and goes into the built page. A build without it would load a
  // dashboard that can't sign anyone in, so it stops here instead. Tests stub Clerk and need no key.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (mode !== "test" && !env.VITE_CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY is not set. Run `direnv allow` (it reads the key from the keyring), " +
        "or pass it as a build argument.",
    );
  }
  return {
    plugins: [react()],
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
