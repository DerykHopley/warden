// Clearing out test databases and test roles a killed run left behind, without touching one a run still uses or one a
// person made.
import { randomBytes } from "node:crypto";
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

async function roleExists(name: string) {
  const { rows } = await superuser.query("select 1 from pg_roles where rolname = $1", [name]);
  return rows.length === 1;
}

// Fixture names are new on each run, so two runs on one Postgres don't make the same database.
const suffix = () => randomBytes(6).toString("hex");

describe("dropStaleTestDatabases", () => {
  it("drops test databases over an hour old, and ones named before names carried a time", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const stale = `warden_test_${twoHoursAgo}_${suffix()}`;
    const untimed = `warden_test_${suffix()}`;
    const recent = `warden_test_${Math.floor(Date.now() / 1000)}_${suffix()}`;
    for (const name of [stale, untimed, recent]) await makeDatabase(name);

    await dropStaleTestDatabases();

    expect(await exists(stale)).toBe(false);
    expect(await exists(untimed)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

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
      await dropStaleTestDatabases();

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
  });
});
