// Telling apart why the start-up connection failed: a database that isn't there yet, a login it refuses, a role
// check that failed, or something else.
import pg from "pg";
import { describe, expect, it } from "vitest";
import { connectionFailure, DatabaseRoleCheckError } from "./database.ts";

function systemError(code: string) {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code });
}

function postgresError(code: string, message: string) {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}

describe("connectionFailure", () => {
  it.each([
    ["a refused connection", systemError("ECONNREFUSED")],
    ["an unknown host", systemError("ENOTFOUND")],
    ["a missing Cloud SQL socket", systemError("ENOENT")],
    ["a timed-out connect", systemError("ETIMEDOUT")],
    [
      "the pool's connection timeout",
      new Error("Connection terminated due to connection timeout", { cause: new Error("x") }),
    ],
    ["a connection closed before it was ready", new Error("Connection terminated unexpectedly")],
  ])("calls %s unreachable", (_, error) => {
    expect(connectionFailure(error)).toBe("unreachable");
  });

  it.each([
    ["a wrong password", postgresError("28P01", 'password authentication failed for user "x"')],
    ["an unknown role", postgresError("28000", 'role "x" does not exist')],
    ["an unknown database", postgresError("3D000", 'database "x" does not exist')],
  ])("calls %s a refused login", (_, error) => {
    expect(connectionFailure(error)).toBe("login refused");
  });

  it("calls a failed role check what it is", () => {
    expect(connectionFailure(new DatabaseRoleCheckError("did not answer in time"))).toBe(
      "role check failed",
    );
  });

  it("calls anything else other", () => {
    expect(connectionFailure(postgresError("53300", "too many connections"))).toBe("other");
    expect(connectionFailure(new Error("something new"))).toBe("other");
  });
});
