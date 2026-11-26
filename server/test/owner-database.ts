// The owner's compose Postgres (compose.yaml, port 54329) is the tests' default, and their own data lives there. An
// agent's run that reached it once made and dropped a database on it (#286), so outside CI the server's tests and the
// browser tests refuse that port unless the person asks for it. Both global setups call this before any connection.

/** The port compose.yaml gives the owner's Postgres on 127.0.0.1. */
const OWNER_PGPORT = "54329";

/** Throws, before anything connects, when `port` is the owner's compose Postgres, `CI` is unset or empty, and
 * `WARDEN_TEST_OWNER_DB` isn't `1`. The error names the port, how to start a throwaway Postgres on a spare port and
 * run `command` there, and the opt-in. */
export function refuseOwnerDatabase(
  port: string | number | undefined,
  command: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (String(port) !== OWNER_PGPORT || env.CI || env.WARDEN_TEST_OWNER_DB === "1") return;
  throw new Error(
    [
      `The tests won't run against port ${OWNER_PGPORT}: that's the owner's compose Postgres, and outside CI they`,
      "run on a throwaway one. Start one on a spare port (podman works the same), run there, then stop it:",
      "",
      "  docker run -d --rm --name warden-test-postgres -p 127.0.0.1:55432:5432 -e POSTGRES_USER=warden \\",
      "    -e POSTGRES_DB=warden -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg17",
      `  PGHOST=127.0.0.1 PGPORT=55432 ${command}`,
      "  docker stop warden-test-postgres",
      "",
      `To run against your own compose database on purpose, set WARDEN_TEST_OWNER_DB=1.`,
    ].join("\n"),
  );
}
