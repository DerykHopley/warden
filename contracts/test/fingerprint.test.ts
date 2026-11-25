import { describe, expect, it } from "vitest";
import { Finding, fingerprint } from "../src/index.ts";
import { finding } from "./fixtures.ts";

const rule = "guard/agent-can-read-env";

describe("fingerprint()", () => {
  it("gives the readable string for each Location kind", () => {
    expect(fingerprint(rule, { kind: "file", path: ".claude/settings.json", line: 3 })).toBe(
      "guard/agent-can-read-env|file:.claude/settings.json",
    );
    expect(
      fingerprint("patch/known-vulnerability", {
        kind: "dependency",
        package: "lodash",
        version: "4.17.20",
        vulnerability: "CVE-2021-23337",
      }),
    ).toBe("patch/known-vulnerability|dependency:lodash|CVE-2021-23337");
    expect(
      fingerprint("patch/outdated", { kind: "dependency", package: "lodash", version: "4.17.20" }),
    ).toBe("patch/outdated|dependency:lodash|");
    expect(
      fingerprint("guard/disk-not-encrypted", { kind: "setting", name: "disk_encryption" }),
    ).toBe("guard/disk-not-encrypted|setting:disk_encryption");
    expect(fingerprint("guard/agent-read-secret-file", { kind: "session" })).toBe(
      "guard/agent-read-secret-file|session",
    );
  });

  it("leaves the Asset out: the same Rule and Location on two Assets give the same Fingerprint", () => {
    const onApp = Finding.parse(finding());
    const onApi = Finding.parse(
      finding({ id: "f-2", asset: { kind: "repo", ref: "https://github.com/example/api" } }),
    );
    expect(onApp.fingerprint).toBe(onApi.fingerprint);
    expect(onApp.fingerprint).toBe(fingerprint(rule, onApi.location));
  });

  it("leaves the line out: a problem that moves lines in a file keeps its Fingerprint", () => {
    expect(fingerprint(rule, { kind: "file", path: ".env.example", line: 3 })).toBe(
      fingerprint(rule, { kind: "file", path: ".env.example", line: 40 }),
    );
  });

  it("leaves the version out: an upgrade isn't a new problem", () => {
    const at = (version: string) =>
      fingerprint("patch/known-vulnerability", {
        kind: "dependency",
        package: "minimist",
        version,
        vulnerability: "CVE-2021-44906",
      });
    expect(at("1.2.5")).toBe(at("1.2.6"));
  });

  it("gives a different Fingerprint for a different path, package or vulnerability", () => {
    expect(fingerprint(rule, { kind: "file", path: "a/.env" })).not.toBe(
      fingerprint(rule, { kind: "file", path: "b/.env" }),
    );
    const dep = {
      kind: "dependency",
      package: "lodash",
      version: "4.17.20",
      vulnerability: "CVE-2021-23337",
    } as const;
    expect(fingerprint("patch/known-vulnerability", dep)).not.toBe(
      fingerprint("patch/known-vulnerability", { ...dep, package: "lodash-es" }),
    );
    expect(fingerprint("patch/known-vulnerability", dep)).not.toBe(
      fingerprint("patch/known-vulnerability", { ...dep, vulnerability: "CVE-2020-8203" }),
    );
  });
});
