// Telling apart why the start-up connection failed: a database that isn't there yet, a login it refuses, a role
// check that failed, or something else.
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  checkDatabaseRole,
  connectionFailure,
  DatabaseRoleCheckError,
  databaseRoleNames,
  PREVIEW_DATABASE_ROLE_NAMES,
} from "./database.ts";

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

describe("checkDatabaseRole's names", () => {
  it("refuses the migration and admin roles of both sets when it's given none", async () => {
    const params: unknown[] = [];
    const client = {
      query: async (_text: string, values: unknown[]) => {
        params.push(values);
        return { rows: [] };
      },
    } as unknown as pg.ClientBase;

    expect(await checkDatabaseRole(client)).toBeUndefined();

    expect(params).toEqual([
      [
        ["warden_migrate", "warden_preview_migrate"],
        ["warden_admin", "warden_preview_admin"],
      ],
    ]);
  });
});

describe("databaseRoleNames", () => {
  it.each([
    ["unset", {}],
    ["empty", { WARDEN_DATABASE_ROLES: "" }],
    ["live", { WARDEN_DATABASE_ROLES: "live" }],
  ])("gives the live set when WARDEN_DATABASE_ROLES is %s", (_, env) => {
    expect(databaseRoleNames(env)).toEqual({
      migrate: "warden_migrate",
      app: "warden_app",
      admin: "warden_admin",
    });
  });

  it("gives the preview set for preview", () => {
    expect(databaseRoleNames({ WARDEN_DATABASE_ROLES: "preview" })).toEqual(
      PREVIEW_DATABASE_ROLE_NAMES,
    );
    expect(PREVIEW_DATABASE_ROLE_NAMES).toEqual({
      migrate: "warden_preview_migrate",
      app: "warden_preview_app",
      admin: "warden_preview_admin",
    });
  });

  it.each(["staging", "Live", "PREVIEW", " live"])(
    "throws for %j, naming the variable and the two allowed values",
    (value) => {
      expect(() => databaseRoleNames({ WARDEN_DATABASE_ROLES: value })).toThrow(
        `WARDEN_DATABASE_ROLES must be live or preview, not "${value}"`,
      );
    },
  );
});
