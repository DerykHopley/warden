// Clearing out test databases and test roles a killed run left behind, without touching one a run still uses or one a
// person made; and waiting for a Postgres that takes no connection yet.
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { dropStaleTestDatabases, dropStaleTestRoles, waitForPostgres } from "./databases.ts";
import { gatedProxy, startingUpPostgres } from "./ports.ts";

const superuser = createPool(
  createLogger(() => {}),
  { max: 1 },
);
const made: string[] = [];
afterEach(async () => {
  for (const name of made.splice(0)) await superuser.query(`drop database if exists ${name}`);
}, 30_000);
afterAll(() => superuser.end());

async function makeDatabase(name: string) {
  made.push(name);
  await superuser.query(`create database ${name}`);
}

async function exists(name: string) {
  const { rows } = await superuser.query("select 1 from pg_database where datname = $1", [name]);
  return rows.length === 1;
}

/** Every database with the tests' prefix, so a failure shows what was there. */
async function testDatabases() {
  const { rows } = await superuser.query<{ datname: string }>(
    "select datname from pg_database where starts_with(datname, 'warden_test_') order by datname",
  );
  return rows.map((row) => row.datname);
}

async function roleExists(name: string) {
  const { rows } = await superuser.query("select 1 from pg_roles where rolname = $1", [name]);
  return rows.length === 1;
}

// Fixture names are new on each run, so two runs on one Postgres don't make the same database.
const suffix = () => randomBytes(6).toString("hex");

describe("dropStaleTestDatabases and dropStaleTestRoles", () => {
  it("drops test databases over an hour old, and ones named before names carried a time", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const stale = `warden_test_${twoHoursAgo}_${suffix()}`;
    const untimed = `warden_test_${suffix()}`;
    const recent = `warden_test_${Math.floor(Date.now() / 1000)}_${suffix()}`;
    for (const name of [stale, untimed, recent]) await makeDatabase(name);

    await dropStaleTestDatabases();

    // One comparison of what was seen, so a failure names each database and whether it was still there.
    const seen = {
      [`stale ${stale}`]: await exists(stale),
      [`untimed ${untimed}`]: await exists(untimed),
      [`recent ${recent}`]: await exists(recent),
    };
    expect(seen, `test databases left: ${(await testDatabases()).join(", ")}`).toEqual({
      [`stale ${stale}`]: false,
      [`untimed ${untimed}`]: false,
      [`recent ${recent}`]: true,
    });
  }, 30_000);

  it("drops test roles over an hour old, and keeps recent ones and ones the tests didn't name", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const stale = [
      `warden_test_${twoHoursAgo}_${suffix()}`,
      `warden_test_${twoHoursAgo}_${suffix()}_app`,
    ];
    const kept = [
      `warden_test_${Math.floor(Date.now() / 1000)}_${suffix()}_app`,
      `warden_test_${twoHoursAgo}_mine_${suffix()}`,
    ];
    for (const name of [...stale, ...kept]) await superuser.query(`create role ${name}`);
    try {
      await dropStaleTestRoles();

      for (const name of stale) expect(await roleExists(name), name).toBe(false);
      for (const name of kept) expect(await roleExists(name), name).toBe(true);
    } finally {
      for (const name of [...stale, ...kept]) await superuser.query(`drop role if exists ${name}`);
    }
  });

  it("keeps a database with the prefix that the tests didn't name", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    // Someone's own databases: no time, a time with their own words, and a suffix that isn't the tests' 12 hex.
    const theirs = [
      `warden_test_mine_${suffix()}`,
      `warden_test_${twoHoursAgo}_mine_${suffix()}`,
      `warden_test_${twoHoursAgo}_${suffix()}ff`,
    ];
    for (const name of theirs) await makeDatabase(name);

    await dropStaleTestDatabases();

    for (const name of theirs) expect(await exists(name), name).toBe(true);
  }, 30_000);
});

// Why the wait exists: waitForPostgres's doc comment (#99).
describe("waitForPostgres", () => {
  it("waits out a Postgres that hangs up on connections at first, then returns", async () => {
    const late = await gatedProxy(Number(process.env.PGPORT));
    try {
      const waiting = waitForPostgres({ host: "127.0.0.1", port: late.port }, { intervalMs: 50 });
      await setTimeout(300);
      late.open();
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      await late.close();
    }
  });

  it("waits out a Postgres that answers it's starting up, then returns", async () => {
    const starting = await startingUpPostgres(Number(process.env.PGPORT));
    try {
      const waiting = waitForPostgres(
        { host: "127.0.0.1", port: starting.port },
        { intervalMs: 50 },
      );
      await setTimeout(300);
      starting.open();
      await expect(waiting).resolves.toBeUndefined();
      expect(starting.refused()).toBeGreaterThan(1);
    } finally {
      await starting.close();
    }
  });

  it("gives up at its deadline, naming the address and the last error", async () => {
    const never = await gatedProxy(Number(process.env.PGPORT));
    try {
      const waiting = waitForPostgres(
        { host: "127.0.0.1", port: never.port },
        { timeoutMs: 300, intervalMs: 50 },
      );
      await expect(waiting).rejects.toThrow(
        `Postgres at 127.0.0.1:${never.port} took no connection within 0.3 s`,
      );
      // The proxy accepts and hangs up; a just-started container's port resets instead. Both read as unreachable.
      await expect(waiting).rejects.toMatchObject({
        cause: { message: "Connection terminated unexpectedly" },
      });
    } finally {
      await never.close();
    }
  });

  it("doesn't wait on a login Postgres refuses", async () => {
    // Waiting out its 10 s deadline would run past the test's 5 s timeout.
    const waiting = waitForPostgres(
      { database: `warden_test_none_${suffix()}` },
      { timeoutMs: 10_000 },
    );
    await expect(waiting).rejects.toMatchObject({ code: "3D000" });
  });
});
