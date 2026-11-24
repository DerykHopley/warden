// Clearing out test databases a killed run left behind, without touching one a run still uses.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPool } from "../src/database.ts";
import { createLogger } from "../src/log.ts";
import { dropStaleTestDatabases } from "./databases.ts";

const superuser = createPool(
  createLogger(() => {}),
  { max: 1 },
);
const made: string[] = [];
afterEach(async () => {
  for (const name of made.splice(0)) await superuser.query(`drop database if exists ${name}`);
});
afterAll(() => superuser.end());

async function makeDatabase(name: string) {
  made.push(name);
  await superuser.query(`create database ${name}`);
}

async function exists(name: string) {
  const { rows } = await superuser.query("select 1 from pg_database where datname = $1", [name]);
  return rows.length === 1;
}

describe("dropStaleTestDatabases", () => {
  it("drops test databases over an hour old, and ones named before names carried a time", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const stale = `warden_test_${twoHoursAgo}_0000000000aa`;
    const untimed = "warden_test_0000000000bb";
    const recent = `warden_test_${Math.floor(Date.now() / 1000)}_0000000000cc`;
    for (const name of [stale, untimed, recent]) await makeDatabase(name);

    await dropStaleTestDatabases();

    expect(await exists(stale)).toBe(false);
    expect(await exists(untimed)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });
});
