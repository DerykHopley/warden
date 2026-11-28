// Setup's Judge's model section (spec #225, slice 6b, story 10): an Admin sees which model judges the Team, sets the
// Team's own model, or puts it back on OpenRouter; a Lead or a Member reads who sets it. The section renders alone with
// spy props over the fake API; Setup's own tests place it and land on its anchor.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@warden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_ANSWERING, TEAM_NOT_OPENED } from "../src/api.ts";
import { dayAndTimeWords } from "../src/date-words.ts";
import { JudgeModelSection } from "../src/JudgeModelSection.tsx";
import { callsTo, deferred, fetchMock, json, serve, type Routes } from "./fake-api.ts";

const WAITING = "Asking Warden's server about the Judge's model…";
const DEFAULT = "The Judge calls OpenRouter (the default).";
const ADMIN_SETS = "An Admin sets the Judge's model.";
const ONLY_ADMIN = "Only an Admin sets the Judge's model.";
const SET_AT = "2026-11-27T09:14:00.000Z";
const URL_SET = "http://localhost:11434/v1";
const MODEL_SET = "qwen3.8:27b";
const PATH = "/api/judge/model";
const FORM = "The Team's own model";

const noModel = () => json(200, { local_model: null });
const modelOf = (url = URL_SET, model = MODEL_SET) =>
  json(200, { local_model: { url, model, set_at: SET_AT } });
const ownModel = () => modelOf();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSection(role: Role, routes: Routes = {}) {
  serve({
    // The Team check a change asks before its PUT: the session is in Acme, as `me` says.
    me: () => json(200, { userId: "user_1", team: "org_a", role, level: "quick" }),
    judgeModel: noModel,
    ...routes,
  });
  const given = {
    getToken: vi.fn(async () => "session-token" as string | null),
    me: { userId: "user_1", team: "org_a", role, level: "quick" as const },
    onSessionEnded: vi.fn(),
    refreshMe: vi.fn(),
    roleChanged: vi.fn(),
    onAnswered: vi.fn(),
    panel: { setContext: vi.fn(), open: vi.fn(), uncover: vi.fn() },
  };
  render(<JudgeModelSection {...given} />);
  return given;
}

const urlField = () => screen.getByRole("textbox", { name: "URL" });
const modelField = () => screen.getByRole("textbox", { name: "Model name" });
const save = () => screen.getByRole("button", { name: "Save" });
const useOpenRouter = () => screen.getByRole("button", { name: "Use OpenRouter" });
const puts = () => callsTo(PATH).filter(([, init]) => init?.method === "PUT");
const sentBodies = () => puts().map(([, init]) => JSON.parse(String(init?.body)) as unknown);

/** Types `url` and `model` into the form (either may be empty) and presses Save. */
async function saveTyped(url: string, model: string) {
  if (url !== "") await userEvent.type(urlField(), url);
  if (model !== "") await userEvent.type(modelField(), model);
  await userEvent.click(save());
}

describe("JudgeModelSection: an Admin", () => {
  it("shows the waiting line, then OpenRouter as the default, with the URL and Model name fields and Save", async () => {
    const answer = deferred<Response>();
    const { onAnswered } = renderSection("admin", { judgeModel: () => answer.promise });

    expect(screen.getByText(WAITING)).toHaveClass("muted");
    expect(onAnswered).not.toHaveBeenCalled();
    answer.resolve(noModel());

    expect(await screen.findByText(DEFAULT)).toBeInTheDocument();
    expect(urlField()).toHaveValue("");
    expect(modelField()).toHaveValue("");
    expect(save()).toHaveClass("primary");
    expect(screen.queryByRole("button", { name: "Use OpenRouter" })).toBeNull();
    // onAnswered runs in a passive effect, which React may flush after the DOM poll above sees the text.
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledWith("judge-model"));
  });

  it("shows the Team's own model's URL, model name and when it was set, with Use OpenRouter", async () => {
    renderSection("admin", { judgeModel: ownModel });

    expect(await screen.findByText(URL_SET)).toBeInTheDocument();
    expect(screen.getByText(MODEL_SET)).toBeInTheDocument();
    expect(screen.getByText(`Set ${dayAndTimeWords(SET_AT)}`)).toHaveClass("muted");
    expect(screen.queryByText(DEFAULT)).toBeNull();
    expect(useOpenRouter()).toHaveClass("secondary");
  });

  it("saves the URL and model name typed, shows the answer, then Use OpenRouter sends null and shows the default", async () => {
    renderSection("admin", {
      setJudgeModel: (body) =>
        (body as { local_model: unknown }).local_model === null ? noModel() : ownModel(),
    });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);
    expect(await screen.findByText(URL_SET)).toBeInTheDocument();
    expect(screen.getByText(MODEL_SET)).toBeInTheDocument();

    await userEvent.click(useOpenRouter());
    expect(await screen.findByText(DEFAULT)).toBeInTheDocument();
    expect(sentBodies()).toEqual([
      { local_model: { url: URL_SET, model: MODEL_SET } },
      { local_model: null },
    ]);
  });

  it("trims the spaces a paste leaves around the URL and the model name before it saves them", async () => {
    renderSection("admin", { setJudgeModel: ownModel });
    await screen.findByText(DEFAULT);

    await saveTyped(` ${URL_SET} `, `${MODEL_SET} `);

    expect(await screen.findByText(URL_SET)).toBeInTheDocument();
    expect(sentBodies()).toEqual([{ local_model: { url: URL_SET, model: MODEL_SET } }]);
  });

  it.each([
    [
      "a private address",
      "http://10.0.0.5/v1",
      MODEL_SET,
      "local_model.url: its scheme isn't https",
    ],
    [
      "a URL over 2048 characters once encoded (#464)",
      `https://models.example.com/${"é".repeat(40)}`,
      MODEL_SET,
      "local_model.url: it's over 2048 characters",
    ],
    ["an empty Model name", "https://models.example.com/v1", "", "local_model.model: is empty"],
  ])(
    "on a 400 for %s, shows the server's words beside the form, keeps the fields, and leaves the shown setting",
    async (_case, url, model, words) => {
      renderSection("admin", {
        judgeModel: () => modelOf("https://models.example.com/v1", "kept-model"),
        setJudgeModel: () => json(400, { error: words }),
      });
      await screen.findByText("kept-model");

      await saveTyped(url, model);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(words);
      expect(alert).toHaveClass("notice");
      // Named apart from its section, "Judge's model", so a screen reader's list of landmarks tells the two apart.
      expect(screen.getByRole("form", { name: FORM })).toContainElement(alert);
      expect(urlField()).toHaveValue(url);
      expect(modelField()).toHaveValue(model);
      expect(screen.getByText("kept-model")).toBeInTheDocument();
      expect(screen.getByText("https://models.example.com/v1")).toBeInTheDocument();
      expect(sentBodies()).toEqual([{ local_model: { url, model } }]);
    },
  );

  it("keeps Save busy and disabled while a save runs, and a second click sends no second PUT", async () => {
    const held = deferred<Response>();
    renderSection("admin", { setJudgeModel: () => held.promise });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    expect(save()).toBeDisabled();
    expect(save()).toHaveAttribute("aria-busy", "true");
    await userEvent.click(save());
    // Enter in a field submits the form too: it sends nothing while the save runs.
    await userEvent.type(modelField(), "{Enter}");
    expect(puts()).toHaveLength(1);

    held.resolve(ownModel());
    expect(await screen.findByText(URL_SET)).toBeInTheDocument();
    expect(save()).toBeEnabled();
    expect(save()).toHaveAttribute("aria-busy", "false");
  });

  it("keeps Use OpenRouter busy and disabled while it runs, Save too, and a second click sends nothing", async () => {
    const held = deferred<Response>();
    renderSection("admin", { judgeModel: ownModel, setJudgeModel: () => held.promise });
    await screen.findByText(URL_SET);

    await userEvent.click(useOpenRouter());
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    expect(useOpenRouter()).toBeDisabled();
    expect(useOpenRouter()).toHaveAttribute("aria-busy", "true");
    expect(save()).toBeDisabled();
    await userEvent.click(useOpenRouter());
    expect(puts()).toHaveLength(1);

    held.resolve(noModel());
    expect(await screen.findByText(DEFAULT)).toBeInTheDocument();
  });

  it("on a 403 for a save, says only an Admin sets it and asks for the Role again once", async () => {
    const { refreshMe, roleChanged } = renderSection("admin", {
      setJudgeModel: () => json(403, { error: "Only an Admin can do this" }),
    });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);

    expect(await screen.findByRole("alert")).toHaveTextContent(ONLY_ADMIN);
    // A later click asks the shell itself, as the agent hook's changes do: Setup's shared ask runs only once a page.
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(roleChanged).not.toHaveBeenCalled();
    expect(screen.getByText(DEFAULT)).toBeInTheDocument();
  });

  it.each([
    ["a 409", () => json(409, {}), TEAM_NOT_OPENED],
    ["a 429", () => json(429, {}, { "Retry-After": "30" }), "Try again in 30 seconds."],
    ["no answer", () => Promise.reject(new TypeError("Failed to fetch")), NOT_ANSWERING],
  ] as const)("on %s for a save, says so beside the form", async (_case, answer, words) => {
    renderSection("admin", { setJudgeModel: answer });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByText(DEFAULT)).toBeInTheDocument();
  });

  it("reads the setting again after a save whose answer was lost, busy still, and shows what the server kept", async () => {
    const reread = deferred<Response>();
    let reads = 0;
    renderSection("admin", {
      judgeModel: () => (++reads === 1 ? noModel() : reread.promise),
      setJudgeModel: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(save()).toBeDisabled();
    reread.resolve(ownModel());

    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_ANSWERING);
    expect(await screen.findByText(URL_SET)).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it("ends the session when a save answers 401", async () => {
    const { onSessionEnded } = renderSection("admin", { setJudgeModel: () => json(401, {}) });
    await screen.findByText(DEFAULT);

    await saveTyped(URL_SET, MODEL_SET);

    await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it("on a 403 for the setting, shows the Lead's line with no form, and asks for the Role again once", async () => {
    const { roleChanged } = renderSection("admin", {
      judgeModel: () => json(403, { error: "Only an Admin can do this" }),
    });

    expect(await screen.findByText(ADMIN_SETS)).toHaveClass("muted");
    await vi.waitFor(() => expect(roleChanged).toHaveBeenCalledOnce());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("on no answer for the setting, offers Retry, and on a 409 says the Team isn't opened", async () => {
    let reads = 0;
    renderSection("admin", {
      judgeModel: () =>
        ++reads === 1 ? Promise.reject(new TypeError("Failed to fetch")) : json(409, {}),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText(TEAM_NOT_OPENED)).toBeInTheDocument();
    expect(reads).toBe(2);
  });
});

describe("JudgeModelSection: a Lead or a Member", () => {
  it.each<Role>(["lead", "member"])(
    "tells a %s an Admin sets it, with no URL field, and asks nothing about it",
    async (role) => {
      renderSection(role);

      expect(screen.getByText(ADMIN_SETS)).toHaveClass("muted");
      expect(screen.queryByRole("textbox", { name: "URL" })).toBeNull();
      // Nothing is asked later either: a tick for any effect to run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callsTo(PATH)).toEqual([]);
    },
  );
});
