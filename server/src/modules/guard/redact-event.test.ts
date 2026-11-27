// Redaction on arrival (#184, threat H8): `redactEvent` masks the home folder, Guard's nine secret types and the log
// redactor's patterns in every string and object key of what the tier filter kept, at any depth.
import { describe, expect, it } from "vitest";
import { RSA_PRIVATE_KEY, SECRET_OF_EACH_TYPE } from "../../../test/secret-fixtures.ts";
import { redactEvent } from "./redact-event.ts";
import { filterToTier } from "./tier-filter.ts";

/** What Guard's secret mask makes of a secret: its first 4 characters, then 8 `*`. */
const mask = (secret: string) => `${secret.slice(0, 4)}********`;

const join = (...parts: string[]) => parts.join("");

describe("redactEvent: Guard's secret types", () => {
  // Each secret ends its string, so a private key's header, masked to the string's end, masks the same text.
  it.each(Object.entries(SECRET_OF_EACH_TYPE))(
    "masks a %s in a top-level string, a nested object, an array and an object key",
    (_type, secret) => {
      const text = `token: ${secret}`;
      const masked = `token: ${mask(secret)}`;

      const redacted = redactEvent({
        error: text,
        tool_input: { env: { TOKEN: text } },
        tool_response: [1, [text]],
        keys: { [text]: true },
      });

      expect(redacted).toEqual({
        error: masked,
        tool_input: { env: { TOKEN: masked } },
        tool_response: [1, [masked]],
        keys: { [masked]: true },
      });
      expect(JSON.stringify(redacted)).not.toContain(secret);
    },
  );

  it("masks two secrets in one string, each with its own mask", () => {
    const { AWS_KEY, GITHUB } = {
      AWS_KEY: SECRET_OF_EACH_TYPE["AWS access key id"],
      GITHUB: SECRET_OF_EACH_TYPE["GitHub token"],
    };
    expect(redactEvent({ prompt: `${AWS_KEY} and ${GITHUB}.` })).toEqual({
      prompt: `${mask(AWS_KEY)} and ${mask(GITHUB)}.`,
    });
  });

  it.each([
    ["an AWS placeholder", join("AKIA", "XXXXXXXXXXXXXXXX")],
    ["AWS's documented example key", join("AKIA", "IOSFODNN7EXAMPLE")],
    ["a Slack placeholder", join("xox", "b-your-bot-token-here")],
  ])("leaves %s as it is", (_name, placeholder) => {
    expect(redactEvent({ prompt: `key=${placeholder}` })).toEqual({
      prompt: `key=${placeholder}`,
    });
  });
});

describe("redactEvent: a private key", () => {
  const body = ["MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn", "r5mN2kQ8bT7vW1xYz3Aq9", "Lp4Rs6Tv1Wx5"];
  const header = join("-----BEGIN ", "OPENSSH PRIVATE KEY-----");
  const footer = join("-----END ", "OPENSSH PRIVATE KEY-----");

  it("masks the whole block, from its BEGIN line through its END line", () => {
    const text = ["before", header, ...body, footer, "after"].join("\n");

    const { tool_response: redacted } = redactEvent({ tool_response: text });

    expect(redacted).toBe(`before\n${mask(header)}\nafter`);
    for (const line of body) expect(redacted).not.toContain(line);
  });

  it("masks the fixture's RSA key block whole", () => {
    expect(redactEvent({ tool_response: `cat id_rsa\n${RSA_PRIVATE_KEY}` })).toEqual({
      tool_response: `cat id_rsa\n${mask(RSA_PRIVATE_KEY)}\n`,
    });
  });

  it("masks to the string's end when there's no END line", () => {
    const text = ["before", header, ...body].join("\n");

    const { tool_response: redacted } = redactEvent({ tool_response: text });

    expect(redacted).toBe(`before\n${mask(header)}`);
    for (const line of body) expect(redacted).not.toContain(line);
  });

  it("masks to the string's end when the END line names another kind of key", () => {
    const text = [header, ...body, join("-----END ", "RSA PRIVATE KEY-----"), "after"].join("\n");

    expect(redactEvent({ tool_response: text })).toEqual({ tool_response: mask(header) });
  });

  it("masks two blocks in one string apart, keeping the text between them", () => {
    const block = [header, ...body, footer].join("\n");

    expect(redactEvent({ tool_response: `${block}\nmiddle\n${block}` })).toEqual({
      tool_response: `${mask(header)}\nmiddle\n${mask(header)}`,
    });
  });
});

describe("redactEvent: the home folder", () => {
  it.each([
    ["/home/<name>/…", "/home/alice/app/a.ts", "~/app/a.ts"],
    ["/var/home/<name>/…", "/var/home/alice/app", "~/app"],
    ["/Users/<name>/…", "/Users/alice/app", "~/app"],
    ["C:\\Users\\<name>\\…", "C:\\Users\\alice\\app", "~\\app"],
    ["c:/users/<name>/…", "c:/users/alice/app", "~/app"],
    ["C:\\\\Users\\\\<name>\\\\… (JSON-escaped)", "C:\\\\Users\\\\alice\\\\app", "~\\\\app"],
    ["\\/home\\/<name>\\/… (JSON-escaped)", "\\/home\\/alice\\/app", "~\\/app"],
    ["a bare /home/<name>", "/home/alice", "~"],
    ["a bare /Users/<name> in quotes", 'cd "/Users/alice"', 'cd "~"'],
    ["a path in a command", "cd /home/alice/app && ls -la", "cd ~/app && ls -la"],
    ["a file:// URL", "open file:///home/alice/app/index.html", "open file://~/app/index.html"],
    ["two home folders", "cp /home/alice/a /home/bob/b", "cp ~/a ~/b"],
    ["a name followed by a shell operator", "ls /home/alice;whoami", "ls ~;whoami"],
    [
      "an encoded .claude/projects/-home-<name>-… folder",
      "/home/alice/.claude/projects/-home-alice-app/s.jsonl",
      "~/.claude/projects/~/s.jsonl",
    ],
    [
      "an encoded -var-home- folder",
      "/var/home/alice/.claude/projects/-var-home-alice-my-app/s.jsonl",
      "~/.claude/projects/~/s.jsonl",
    ],
    [
      "an encoded -Users- folder",
      "/Users/alice/.claude/projects/-Users-alice-app/s.jsonl",
      "~/.claude/projects/~/s.jsonl",
    ],
    [
      "an encoded C--Users- folder",
      "C:\\Users\\alice\\.claude\\projects\\C--Users-alice-app\\s.jsonl",
      "~\\.claude\\projects\\~\\s.jsonl",
    ],
  ])("turns %s into ~", (_form, text, redacted) => {
    expect(redactEvent({ cwd: text })).toEqual({ cwd: redacted });
  });

  it("masks a home folder in an object key and a nested string", () => {
    expect(
      redactEvent({ tool_response: { "/home/alice/a.ts": [{ path: "/Users/alice/b" }] } }),
    ).toEqual({ tool_response: { "~/a.ts": [{ path: "~/b" }] } });
  });

  it.each([
    ["a URL's /home/ path", "https://example.com/home/alice"],
    ["a folder named like one inside another", "/srv/myhome/alice"],
    ["an encoded project folder outside a home folder", "~/.claude/projects/-srv-app/s.jsonl"],
  ])("leaves %s as it is", (_name, text) => {
    expect(redactEvent({ cwd: text })).toEqual({ cwd: text });
  });
});

describe("redactEvent: the log redactor's patterns", () => {
  it.each([
    ["a Bearer token", "curl -H 'Authorization: Bearer abc.def-123'", "Bearer ***"],
    [
      "a JWT",
      join("token=", "eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxIn0", ".c2lnbmF0dXJl"),
      "token=***",
    ],
    [
      "a URL's query value",
      "curl https://api.example.com/v1?key=s3cr3t&page=2",
      "?key=***&page=***",
    ],
  ])("masks %s", (_name, text, masked) => {
    const { prompt } = redactEvent({ prompt: text });
    expect(prompt).toContain(masked);
  });

  it("leaves a string holding no secret and no home folder unchanged", () => {
    const fields = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test --filter @warden/server", description: "Run the tests" },
      tool_response: { stdout: "Tests: 12 passed", exit: 0, interrupted: false, extra: null },
    };
    expect(redactEvent(fields)).toEqual(fields);
  });
});

describe("redactEvent: a __proto__ key", () => {
  const body =
    '{"session_id": "s", "hook_event_name": "PostToolUse", "tool_input": {"__proto__": {"polluted": "/home/alice"}, "command": "ls"}}';

  it.each(["details", "content"] as const)(
    "stores nothing on any object's prototype at %s, and the copy's prototype is Object.prototype",
    (tier) => {
      const event = JSON.parse(body) as Record<string, unknown>;

      const redacted = redactEvent(filterToTier(event, tier));

      const toolInput = redacted.tool_input as Record<string, unknown>;
      expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(toolInput)).toBe(Object.prototype);
      expect(toolInput.command).toBe("ls");
      expect(toolInput.polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(JSON.stringify(redacted)).not.toContain("alice");
    },
  );

  it("keeps a __proto__ key at content as an ordinary key, redacted", () => {
    const event = JSON.parse(body) as Record<string, unknown>;

    const toolInput = redactEvent(filterToTier(event, "content")).tool_input as object;

    expect(Object.getOwnPropertyDescriptor(toolInput, "__proto__")?.value).toEqual({
      polluted: "~",
    });
  });
});
