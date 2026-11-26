// The detail card's Patch section (spec #101, stories 5 and 6): a Patch Finding's assessment, read from
// `GET /api/patch/findings/:id/assessment`, in words: whether the version is affected and why, what fixes it, who acts,
// how urgent it is and when it's due, and its NVD and OSV pages. It renders DetailCard, Warden's server faked; the
// card's other parts are DetailCard.test.tsx's.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PatchAssessment, type Finding, type Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailCard } from "../src/DetailCard.tsx";
import { earliestUntil } from "../src/decisions.ts";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";
import { finding } from "./findings-fixture.ts";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = "5e1f0c2a-0000-4000-8000-000000000001";
const ASSESSMENT_PATH = `/api/patch/findings/${ID}/assessment`;

/** An Open CVE Finding on a Product, as a Patch Scan opens one. */
const PATCH: Finding = finding(ID, {
  module: "patch",
  rule_id: "patch/known-vulnerability",
  asset: { kind: "product", ref: "9b7c0d1e-0000-4000-8000-000000000009" },
  location: {
    kind: "dependency",
    package: "pkg:pypi/langchain",
    version: "0.0.200",
    vulnerability: "CVE-2023-36258",
  },
  severity: "critical",
  title: "CVE-2023-36258: LangChain runs code from a prompt",
  evidence: { summary: "langchain 0.0.200 is affected by CVE-2023-36258" },
});

/** A valid assessment, as the route answers it; `fields` changes it. */
function assessment(fields: Partial<PatchAssessment> = {}): PatchAssessment {
  return PatchAssessment.parse({
    finding_id: ID,
    cve_id: "CVE-2023-36258",
    dependency: {
      framework: "langchain",
      version: "0.0.200",
      usage: "library",
      internet_facing: true,
    },
    verdict: "affected",
    reason: "0.0.200 is in the affected range, before 0.0.236",
    fixed_version: "0.0.236",
    fixes: [],
    who_acts: "you",
    priority: {
      level: "urgent",
      reasons: ["CISA lists it as exploited (KEV)", "internet-facing"],
      due_date: "2027-01-15",
      due_from: "published + 90 days",
      overdue: false,
    },
    kev: null,
    epss: null,
    links: {
      nvd: "https://nvd.nist.gov/vuln/detail/CVE-2023-36258",
      osv: ["https://osv.dev/vulnerability/GHSA-gjjr-63x4-v8cq"],
    },
    ...fields,
  });
}

const priority = (fields: Partial<PatchAssessment["priority"]>) => ({
  ...assessment().priority,
  ...fields,
});

const onSessionEnded = vi.fn();
const onFindingChanged = vi.fn();
const sessionToken = () => Promise.resolve("session-token" as string | null);

/** /api/me's answer: the session is in the Patch Finding's Team. */
const inTeam = () =>
  json(200, { userId: "user_me", team: PATCH.team, role: "member", level: "quick" });

/**
 * Renders the card for `focused`, as a person with `role`, with the server's routes `routes` (/api/me says the session
 * is in the Finding's Team, unless `routes` says otherwise).
 */
function show(
  focused: Finding,
  routes: Routes,
  role: Role | null = null,
  getToken: () => Promise<string | null> = sessionToken,
) {
  onSessionEnded.mockReset();
  onFindingChanged.mockReset();
  serve({ me: inTeam, ...routes });
  const element = (shown: Finding) => (
    <DetailCard
      finding={shown}
      proposals={{ kind: "proposals", team: shown.team, proposals: [] }}
      clerkUsers={new Map()}
      role={role}
      userId="user_me"
      getToken={getToken}
      candidates={[]}
      productName={null}
      onClear={() => {}}
      onRetryProposals={() => {}}
      onFindingChanged={onFindingChanged}
      onFindingGone={() => {}}
      onProposalsChanged={() => {}}
      refreshMe={() => {}}
      onSessionEnded={onSessionEnded}
    />
  );
  const { rerender, unmount } = render(element(focused));
  return {
    card: within(screen.getByRole("region", { name: focused.title })),
    /** The card again, as the page hands it the Finding asked again. */
    update: (shown: Finding) => rerender(element(shown)),
    unmount,
  };
}

/** The card's Patch section, once it has shown. */
const section = (card: ReturnType<typeof show>["card"]) =>
  within(card.getByRole("region", { name: "Patch" }));

/** The Patch section's assessment, once it has loaded: each row's label and its value's element. */
async function rows(card: ReturnType<typeof show>["card"]) {
  const patch = section(card);
  const terms = await patch.findAllByRole("term");
  return Object.fromEntries(
    terms.map((term) => [term.textContent, term.nextElementSibling]),
  ) as Record<string, HTMLElement | undefined>;
}

const answering = (body: PatchAssessment = assessment()): Routes => ({
  assessment: () => json(200, body),
});

describe("the Patch section of a Patch Finding's card", () => {
  it("shows the verdict and its reason, Fixed in, Who acts, the priority with its reasons and due day, and the NVD and OSV links", async () => {
    const { card } = show(PATCH, answering());
    expect(section(card).getByRole("heading", { level: 4, name: "Patch" })).toBeVisible();

    const row = await rows(card);
    expect(Object.keys(row)).toEqual(["Your version", "Fixed in", "Who acts", "Priority", "Links"]);
    expect(row["Your version"]).toHaveTextContent(
      /^Affected 0\.0\.200 is in the affected range, before 0\.0\.236$/,
    );
    expect(row["Fixed in"]).toHaveTextContent(/^0\.0\.236$/);
    expect(row["Who acts"]).toHaveTextContent(/^You$/);
    const level = row.Priority!;
    expect(level).toHaveTextContent(/^Urgent/);
    expect(
      within(level)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["CISA lists it as exploited (KEV)", "internet-facing"]);
    expect(level).toHaveTextContent(/Due Jan 15, 2027 \(published \+ 90 days\)$/);

    const links = within(row.Links!).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["NVD", "https://nvd.nist.gov/vuln/detail/CVE-2023-36258"],
      ["OSV", "https://osv.dev/vulnerability/GHSA-gjjr-63x4-v8cq"],
    ]);
    expect(callsTo(ASSESSMENT_PATH)).toHaveLength(1);
  });

  it("names several OSV pages OSV 1, OSV 2", async () => {
    const { card } = show(
      PATCH,
      answering(
        assessment({
          links: {
            nvd: "https://nvd.nist.gov/vuln/detail/CVE-2023-36258",
            osv: ["https://osv.dev/vulnerability/A", "https://osv.dev/vulnerability/B"],
          },
        }),
      ),
    );
    const row = await rows(card);
    expect(
      within(row.Links!)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["NVD", "OSV 1", "OSV 2"]);
  });

  it("each link opens in a new tab, with rel noopener noreferrer", async () => {
    const { card } = show(PATCH, answering());
    const row = await rows(card);
    for (const link of within(row.Links!).getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it.each<[PatchAssessment["verdict"], string]>([
    ["affected", "Affected"],
    ["not_affected", "Not affected"],
    ["unknown", "Can't tell"],
  ])("a %s verdict reads %s", async (verdict, words) => {
    const { card } = show(PATCH, answering(assessment({ verdict })));
    const row = await rows(card);
    expect(row["Your version"]!.firstElementChild).toHaveTextContent(new RegExp(`^${words}$`));
  });

  it.each<[PatchAssessment["who_acts"], string]>([
    ["you", "You"],
    ["upstream", "Upstream: the package that brings it in"],
    ["vendor", "The vendor"],
    [null, "No one now: the Product no longer uses this framework."],
  ])("who acts %s reads %s", async (who_acts, words) => {
    const { card } = show(
      PATCH,
      answering(assessment({ who_acts, ...(who_acts === null ? { dependency: null } : {}) })),
    );
    const row = await rows(card);
    expect(row["Who acts"]).toHaveTextContent(new RegExp(`^${words.replace(/[.]/g, "\\.")}$`));
  });

  it("with two fixes, shows one line per package, no fix listed yet for a package without one", async () => {
    const { card } = show(
      PATCH,
      answering(
        assessment({
          fixed_version: "0.0.236",
          fixes: [
            { package: "langchain", fixed_version: "0.0.236" },
            { package: "langchain-experimental", fixed_version: null },
          ],
        }),
      ),
    );
    const row = await rows(card);
    expect(
      within(row["Fixed in"]!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["langchain: 0.0.236", "langchain-experimental: no fix listed yet"]);
  });

  it("with no fixed version and no fixes, says No fix listed yet.", async () => {
    const { card } = show(PATCH, answering(assessment({ fixed_version: null, fixes: [] })));
    const row = await rows(card);
    expect(row["Fixed in"]).toHaveTextContent(/^No fix listed yet\.$/);
  });

  it.each<[string, PatchAssessment["priority"]["level"]]>([
    ["High", "high"],
    ["Normal", "normal"],
    ["Low", "low"],
  ])("names the level %s, and shows no reasons list when it has none", async (words, level) => {
    const { card } = show(
      PATCH,
      answering(assessment({ priority: priority({ level, reasons: [] }) })),
    );
    const row = await rows(card);
    expect(row.Priority).toHaveTextContent(new RegExp(`^${words}`));
    expect(within(row.Priority!).queryByRole("list")).toBeNull();
  });

  it("flags an overdue Finding Overdue, in words; one not overdue has no flag", async () => {
    const overdue = show(PATCH, answering(assessment({ priority: priority({ overdue: true }) })));
    const flagged = await rows(overdue.card);
    const flag = within(flagged.Priority!).getByText("Overdue");
    expect(flag).toHaveClass("flag");
    // Spaced by .flag's own margin, as the card's Unconfirmed fix flag is, with no space of text before it.
    expect(flag.previousSibling).toBe(within(flagged.Priority!).getByText("Urgent"));
    overdue.unmount();

    const onTime = show(PATCH, answering());
    const plain = await rows(onTime.card);
    expect(within(plain.Priority!).queryByText("Overdue")).toBeNull();
  });

  it.each<[Finding["status"], boolean]>([
    ["fixed", false],
    ["false_positive", false],
    ["accepted", true],
  ])("a %s Finding's section has a Priority row: %s", async (status, hasPriority) => {
    const { card } = show(
      {
        ...PATCH,
        status,
        accepted_reason: status === "accepted" ? "Patched next sprint" : null,
        accepted_until: status === "accepted" ? "2027-02-22T12:00:00Z" : null,
      },
      answering(),
    );
    const row = await rows(card);
    expect("Priority" in row).toBe(hasPriority);
    expect(row["Who acts"]).toBeDefined();
  });

  it("shows Loading the CVE assessment… until the answer", async () => {
    const late = deferred<Response>();
    const { card } = show(PATCH, { assessment: () => late.promise });
    expect(section(card).getByText("Loading the CVE assessment…")).toHaveClass("muted");
    late.resolve(json(200, assessment()));
    await rows(card);
    expect(section(card).queryByText("Loading the CVE assessment…")).toBeNull();
  });

  it("shows every string from the assessment as text, never as markup", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const { card } = show(
      PATCH,
      answering(
        assessment({
          reason: markup,
          fixes: [
            { package: markup, fixed_version: "1.0.0" },
            { package: "other", fixed_version: null },
          ],
          priority: priority({ reasons: [markup], due_from: markup }),
        }),
      ),
    );
    const row = await rows(card);
    expect(row["Your version"]).toHaveTextContent(markup);
    expect(row["Fixed in"]).toHaveTextContent(markup);
    expect(within(row.Priority!).getByRole("listitem")).toHaveTextContent(markup);
    expect(row.Priority).toHaveTextContent(`(${markup})`);
    expect(document.querySelector(".detail-card img")).toBeNull();
  });

  it("leaves out an OSV page that isn't https: as a link, the http: and javascript: ones alike", async () => {
    const body = assessment({
      links: {
        nvd: "https://nvd.nist.gov/vuln/detail/CVE-2023-36258",
        osv: ["http://osv.dev/vulnerability/A", "javascript:alert(1)"],
      },
    });
    const { card } = show(PATCH, answering(body));
    const row = await rows(card);
    expect(
      within(row.Links!)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["https://nvd.nist.gov/vuln/detail/CVE-2023-36258"]);
  });
});

describe("a card that isn't a Patch Finding's", () => {
  it("a Guard Finding's card has no Patch section and asks for no assessment", async () => {
    const assessmentRoute = vi.fn(() => json(200, assessment()));
    const { card } = show(finding(ID), { assessment: assessmentRoute });
    expect(card.queryByRole("region", { name: "Patch" })).toBeNull();
    // Let any call the card would make go out before counting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assessmentRoute).not.toHaveBeenCalled();
    expect(callsTo(ASSESSMENT_PATH)).toHaveLength(0);
  });
});

describe("the Patch section's refusals", () => {
  it("a 404 with an error shows the server's words, muted, with no Retry", async () => {
    const words = "The CVE snapshot doesn't hold GHSA-demo-0001, so its Finding can't be assessed";
    const { card } = show(PATCH, { assessment: () => json(404, { error: words }) });
    const patch = section(card);
    expect(await patch.findByText(words)).toHaveClass("muted");
    expect(patch.queryByRole("button")).toBeNull();
  });

  it("a 404 without a body says Warden has no CVE assessment for this Finding.", async () => {
    const { card } = show(PATCH, { assessment: () => new Response(null, { status: 404 }) });
    const patch = section(card);
    expect(await patch.findByText("Warden has no CVE assessment for this Finding.")).toHaveClass(
      "muted",
    );
    expect(patch.queryByRole("button")).toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 500", () => json(500, { error: "boom" })],
    ["a 403", () => json(403, { error: "no Team" })],
    ["a 409", () => json(409, { error: "not opened" })],
    ["a body that doesn't parse", () => json(200, { ...assessment(), verdict: "maybe" })],
  ])(
    "%s shows Couldn't load the CVE assessment. with Retry, busy while it runs; Retry asks again and shows the section",
    async (_, failed) => {
      const again = deferred<Response>();
      const answers = [failed, () => again.promise];
      const { card } = show(PATCH, { assessment: () => answers.shift()!() });
      const patch = section(card);
      expect(await patch.findByText("Couldn't load the CVE assessment.")).toBeVisible();

      // Named apart from the Proposals' Retry, which can show in the same card; it still reads Retry.
      const retry = patch.getByRole("button", { name: "Retry the CVE assessment" });
      expect(retry).toHaveTextContent(/^Retry$/);
      expect(retry).toHaveClass("secondary");
      await userEvent.click(retry);
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toBeDisabled();
      expect(callsTo(ASSESSMENT_PATH)).toHaveLength(2);

      again.resolve(json(200, assessment()));
      const row = await rows(card);
      expect(row["Who acts"]).toHaveTextContent("You");
      expect(patch.queryByText("Couldn't load the CVE assessment.")).toBeNull();
    },
  );

  it("a 429 with Retry-After 30 says to try again in 30 seconds, with Retry", async () => {
    const { card } = show(PATCH, {
      assessment: () => json(429, { error: "slow down" }, { "Retry-After": "30" }),
    });
    const patch = section(card);
    expect(
      await patch.findByText("Too many sign-in attempts. Try again in 30 seconds."),
    ).toBeVisible();
    expect(patch.getByRole("button", { name: "Retry the CVE assessment" })).toBeVisible();
  });

  it("right after a Team switch, a token for the Team just left asks no assessment: the section shows the Finding's Team's answer, not its 404", async () => {
    let tokens = 0;
    const getTokens = async () => `token-${++tokens}` as string | null;
    const teamOf = (init: RequestInit | undefined) =>
      new Headers(init?.headers).get("Authorization") === "Bearer token-1"
        ? "org_left"
        : PATCH.team;
    const { card } = show(
      PATCH,
      {
        me: () => {
          const [, init] = callsTo("/api/me").at(-1)!;
          return json(200, {
            userId: "user_me",
            team: teamOf(init),
            role: "member",
            level: "quick",
          });
        },
        assessment: () => {
          const [, init] = callsTo(ASSESSMENT_PATH).at(-1)!;
          return teamOf(init) === PATCH.team
            ? json(200, assessment())
            : json(404, { error: "No such Patch Finding" });
        },
      },
      null,
      getTokens,
    );
    const row = await rows(card);
    expect(row["Who acts"]).toHaveTextContent("You");
    expect(section(card).queryByText("No such Patch Finding")).toBeNull();
  });

  it("a 401 ends the session", async () => {
    show(PATCH, { assessment: () => json(401, { error: "signed out" }) });
    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });
});

describe("when the Patch section asks again", () => {
  it("asks once when the card opens, and again after an Accept changes the Finding to Accepted; the first ask's late answer is dropped", async () => {
    const first = deferred<Response>();
    const answers = [
      () => first.promise,
      () => json(200, assessment({ priority: priority({ level: "low" }) })),
    ];
    const ACCEPTED: Finding = {
      ...PATCH,
      status: "accepted",
      accepted_reason: "Patched next sprint",
      accepted_until: new Date(`${earliestUntil()}T00:00`).toISOString(),
    };
    const { card, update } = show(
      PATCH,
      {
        assessment: () => answers.shift()!(),
        findingAction: () => json(200, ACCEPTED),
      },
      "lead",
    );
    await vi.waitFor(() => expect(callsTo(ASSESSMENT_PATH)).toHaveLength(1));

    await userEvent.click(card.getByRole("button", { name: "Accept" }));
    const form = within(card.getByRole("form", { name: "Accept" }));
    await userEvent.type(
      form.getByRole("textbox", { name: "Why accept this risk?" }),
      "Patched next sprint",
    );
    fireEvent.change(form.getByLabelText("Reopens on"), { target: { value: earliestUntil() } });
    await userEvent.click(form.getByRole("button", { name: "Accept" }));
    await vi.waitFor(() => expect(onFindingChanged).toHaveBeenCalled());

    // The page asks for the Finding again, and hands the card its new Status.
    update(ACCEPTED);
    await vi.waitFor(() => expect(callsTo(ASSESSMENT_PATH)).toHaveLength(2));
    const row = await rows(card);
    expect(row.Priority).toHaveTextContent(/^Low/);

    first.resolve(json(200, assessment()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await rows(card)).Priority).toHaveTextContent(/^Low/);
  });

  it("doesn't ask again when the card is handed the same Finding unchanged", async () => {
    const { card, update } = show(PATCH, answering());
    await rows(card);
    update({ ...PATCH });
    await rows(card);
    expect(callsTo(ASSESSMENT_PATH)).toHaveLength(1);
  });
});
