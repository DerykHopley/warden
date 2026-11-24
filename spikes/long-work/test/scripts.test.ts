// up.sh and down.sh against a fake gcloud, curl and podman (test/fake-bin). Nothing reaches Google.
// Run with: node --test spikes/long-work/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const spike = fileURLToPath(new URL("..", import.meta.url));
const fakeBin = join(spike, "test", "fake-bin");
const ALL_APIS = [
  "run.googleapis.com",
  "artifactregistry.googleapis.com",
  "secretmanager.googleapis.com",
  "cloudtasks.googleapis.com",
  "cloudscheduler.googleapis.com",
  "iam.googleapis.com",
];

function fakeProject(enabled: string[], state: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "spike-long-work-test-"));
  writeFileSync(join(dir, "enabled"), enabled.join("\n") + "\n");
  writeFileSync(join(dir, "state"), state.map((line) => line + "\n").join(""));
  writeFileSync(join(dir, "calls"), "");
  return dir;
}

function run(script: string, dir: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [join(spike, script)], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: dir,
      FAKE_DIR: dir,
      RESULTS_DIR: join(dir, "results"),
      CONTAINER: "podman",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean);
  const state = readFileSync(join(dir, "state"), "utf8").trim();
  return { code: result.status, output: result.stdout + result.stderr, calls, state };
}

test("up.sh refuses to start when an API it needs is off, creating nothing", () => {
  const dir = fakeProject(ALL_APIS.filter((api) => !api.startsWith("cloud")));
  const { code, output, calls, state } = run("up.sh", dir);
  assert.notEqual(code, 0);
  assert.match(output, /cloudtasks\.googleapis\.com/);
  assert.match(output, /cloudscheduler\.googleapis\.com/);
  assert.match(calls[0], /^gcloud services list --enabled/);
  assert.ok(
    !calls.some((call) => / (create|deploy|add-iam-policy-binding) /.test(call)),
    calls.join("\n"),
  );
  assert.equal(state, "");
});

test("up.sh refuses to start when spike resources are left from an earlier run", () => {
  const dir = fakeProject(ALL_APIS, ["secrets spike-long-work-secret"]);
  const { code, output, calls } = run("up.sh", dir);
  assert.notEqual(code, 0);
  assert.match(output, /down\.sh/);
  assert.ok(!calls.some((call) => / (create|deploy) /.test(call)));
});

test("up.sh creates every resource private, labelled and named spike-long-work, and never prints the secret", () => {
  const dir = fakeProject(ALL_APIS);
  const { code, output, calls, state } = run("up.sh", dir);
  assert.equal(code, 0, output);

  const names = state.split("\n").map((line) => line.split(" ").at(-1) ?? "");
  // Service account, secret, repository, three services, the job, the queue and the Scheduler job.
  assert.equal(names.length, 9, state);
  for (const name of names) assert.match(name, /^spike-long-work/);

  const deploys = calls.filter((call) => call.startsWith("gcloud run deploy"));
  assert.equal(deploys.length, 3);
  for (const call of [...deploys, ...calls.filter((c) => c.startsWith("gcloud run jobs create"))]) {
    assert.match(call, /--service-account=spike-long-work@/);
    assert.match(call, /--labels=purpose=spike-long-work/);
    assert.match(call, /--set-secrets=SPIKE_SECRET=spike-long-work-secret:1/);
  }
  for (const call of deploys) assert.match(call, /--no-allow-unauthenticated/);
  assert.ok(deploys.some((call) => /--no-cpu-throttling/.test(call)));
  assert.ok(deploys.some((call) => /--timeout=60 /.test(call + " ")));
  for (const prefix of ["gcloud secrets create", "gcloud artifacts repositories create"]) {
    assert.match(
      calls.find((call) => call.startsWith(prefix)) ?? "",
      /--labels=purpose=spike-long-work/,
    );
  }
  assert.ok(
    !calls.some((call) => call.includes("allow-unauthenticated") && !call.includes("--no-")),
  );
  assert.ok(!calls.some((call) => /warden-db|warden-clerk/.test(call)));

  // The secret: generated, piped straight to Secret Manager, never in the log.
  const secret = readFileSync(join(dir, "secret-value"), "utf8").trim();
  assert.ok(secret.length >= 32);
  assert.ok(!output.includes(secret));
  assert.ok(existsSync(join(dir, "results")));

  // The access check: every service answers 403 without a Google identity.
  assert.match(output, /spike-long-work-throttled: 403 without a token/);
});

test("down.sh deletes everything up.sh made and ends with an empty leftover listing", () => {
  const dir = fakeProject(ALL_APIS);
  assert.equal(run("up.sh", dir).code, 0);
  const { code, output, state } = run("down.sh", dir);
  assert.equal(code, 0, output);
  assert.equal(state, "");
  assert.match(output, /Leftovers named spike-long-work: none/);
});

test("down.sh is safe after a failed up.sh: a partial set, with two APIs off", () => {
  const dir = fakeProject(
    ALL_APIS.filter((api) => !api.startsWith("cloud")),
    [
      "iam service-accounts spike-long-work@coherent-bay-515713-r7.iam.gserviceaccount.com",
      "secrets spike-long-work-secret",
    ],
  );
  const { code, output, state } = run("down.sh", dir);
  assert.equal(code, 0, output);
  assert.equal(state, "");
  assert.match(output, /Leftovers named spike-long-work: none/);
});

test("down.sh deletes the service account even when the IAM API isn't listed as enabled", () => {
  // On the real project, service accounts list fine while iam.googleapis.com isn't in the enabled list.
  const dir = fakeProject(
    ["run.googleapis.com"],
    ["iam service-accounts spike-long-work@coherent-bay-515713-r7.iam.gserviceaccount.com"],
  );
  const { code, output, state } = run("down.sh", dir);
  assert.equal(code, 0, output);
  assert.equal(state, "");
});

test("down.sh is safe with nothing there at all", () => {
  const { code, output } = run("down.sh", fakeProject(ALL_APIS));
  assert.equal(code, 0, output);
  assert.match(output, /Leftovers named spike-long-work: none/);
});

test("down.sh fails when something named spike-long-work is still there at the end", () => {
  const dir = fakeProject(ALL_APIS, ["secrets spike-long-work-secret"]);
  const { code, output } = run("down.sh", dir, { FAKE_STUCK: "spike-long-work-secret" });
  assert.notEqual(code, 0);
  assert.match(output, /secret spike-long-work-secret/);
});

test("down.sh never touches a resource without the spike's prefix", () => {
  const dir = fakeProject(ALL_APIS, ["secrets warden-db-password", "run services warden"]);
  const { code, calls, state } = run("down.sh", dir);
  assert.equal(code, 0);
  assert.ok(!calls.some((call) => / delete .*warden/.test(call)), calls.join("\n"));
  assert.match(state, /warden-db-password/);
});
