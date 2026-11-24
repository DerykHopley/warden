// The Ask Warden panel's rules below the UI: its starting state by window width and a person's stored choice, how it
// shows at each width, its width limits, what a change shows and what it chooses, its context line's view words, and
// its closed button's words.
import { describe, expect, it } from "vitest";
import {
  askWardenLabel,
  clampWidth,
  findingsViewWords,
  panelReducer,
  panelShownAs,
  startingPanel,
  type PanelStore,
} from "../src/panel.ts";

const stored = (value: unknown) => JSON.stringify(value);

describe("startingPanel", () => {
  it.each([
    [390, "closed"],
    [1024, "closed"],
    [1400, "closed"],
    [1600, "closed"],
    [1601, "pinned"],
    [1700, "pinned"],
  ] as const)("with nothing stored, at %ipx starts %s at 400px", (width, mode) => {
    expect(startingPanel(width, null)).toEqual({ mode, width: 400 });
  });

  it("takes a stored choice over the width default", () => {
    expect(startingPanel(1700, stored({ mode: "closed", width: 400 }))).toEqual({
      mode: "closed",
      width: 400,
    });
    expect(startingPanel(1024, stored({ mode: "floating", width: 512 }))).toEqual({
      mode: "floating",
      width: 512,
    });
    expect(startingPanel(1400, stored({ mode: "pinned", width: 680 }))).toEqual({
      mode: "pinned",
      width: 680,
    });
  });

  it.each([
    ["isn't JSON", "{not json"],
    ["isn't an object", stored("pinned")],
    ["names no mode", stored({ width: 400 })],
    ["names an unknown mode", stored({ mode: "docked", width: 400 })],
    ["has no width", stored({ mode: "closed" })],
    ["has a width that isn't a number", stored({ mode: "closed", width: "400" })],
    ["has a width under 320", stored({ mode: "closed", width: 319 })],
    ["has a width over 680", stored({ mode: "closed", width: 681 })],
    ["has a width that isn't whole", stored({ mode: "closed", width: 400.5 })],
  ])("ignores a stored value that %s: the width default", (_why, value) => {
    expect(startingPanel(1700, value)).toEqual({ mode: "pinned", width: 400 });
    expect(startingPanel(1024, value)).toEqual({ mode: "closed", width: 400 });
  });
});

describe("panelShownAs", () => {
  it("under 640px, an open panel is full screen", () => {
    expect(panelShownAs("floating", 390)).toBe("full-screen");
    expect(panelShownAs("pinned", 639)).toBe("full-screen");
    expect(panelShownAs("closed", 390)).toBe("closed");
  });

  it("from 640px to under 1100px, a pinned panel floats: pinning is offered from 1100px", () => {
    expect(panelShownAs("pinned", 640)).toBe("floating");
    expect(panelShownAs("pinned", 1099)).toBe("floating");
    expect(panelShownAs("floating", 1024)).toBe("floating");
  });

  it("from 1100px, each mode shows as itself", () => {
    expect(panelShownAs("pinned", 1100)).toBe("pinned");
    expect(panelShownAs("floating", 1400)).toBe("floating");
    expect(panelShownAs("closed", 1700)).toBe("closed");
  });
});

describe("the context line's view words", () => {
  it("name the page, then each filter that isn't all, in the order status, severity, module, in the dashboard's words", () => {
    expect(findingsViewWords({ status: "open", severity: "all", module: "all" })).toEqual([
      "Findings",
      "Open",
    ]);
    expect(
      findingsViewWords({ status: "false_positive", severity: "critical", module: "patch" }),
    ).toEqual(["Findings", "False positive", "Critical", "Patch"]);
    expect(findingsViewWords({ status: "all", severity: "all", module: "guard" })).toEqual([
      "Findings",
      "Guard",
    ]);
  });
});

describe("clampWidth", () => {
  it("keeps a width within 320 to 680px, in whole pixels", () => {
    expect(clampWidth(319)).toBe(320);
    expect(clampWidth(-50)).toBe(320);
    expect(clampWidth(320)).toBe(320);
    expect(clampWidth(500.4)).toBe(500);
    expect(clampWidth(680)).toBe(680);
    expect(clampWidth(681)).toBe(680);
    expect(clampWidth(5000)).toBe(680);
  });
});

describe("panelReducer: what shows, and what the person chose", () => {
  const start: PanelStore = { shown: { mode: "closed", width: 400 }, chosen: null };

  it("a choice shows and is chosen", () => {
    expect(panelReducer(start, { type: "choose", mode: "pinned" })).toEqual({
      shown: { mode: "pinned", width: 400 },
      chosen: { mode: "pinned", width: 400 },
    });
  });

  it("a close that keeps the choice shows without choosing", () => {
    const chosen = { mode: "pinned", width: 512 } as const;
    const open = { shown: { mode: "pinned", width: 512 }, chosen } as const;
    expect(panelReducer(open, { type: "show", mode: "closed" })).toEqual({
      shown: { mode: "closed", width: 512 },
      chosen,
    });
  });

  it("an automatic open floats a closed panel without choosing, and leaves an open one", () => {
    expect(panelReducer(start, { type: "open" })).toEqual({
      shown: { mode: "floating", width: 400 },
      chosen: null,
    });
    const pinned = panelReducer(start, { type: "choose", mode: "pinned" });
    expect(panelReducer(pinned, { type: "open" })).toBe(pinned);
  });

  it("a drag resizes what shows, clamped, and its end chooses it", () => {
    const pinned = panelReducer(start, { type: "choose", mode: "pinned" });
    const dragging = panelReducer(pinned, { type: "resize", width: 900 });
    expect(dragging).toEqual({ shown: { mode: "pinned", width: 680 }, chosen: pinned.chosen });
    expect(panelReducer(dragging, { type: "commit" })).toEqual({
      shown: { mode: "pinned", width: 680 },
      chosen: { mode: "pinned", width: 680 },
    });
  });
});

describe("the closed panel's button", () => {
  it("reads Ask Warden, then the count of sent messages once there are any", () => {
    expect(askWardenLabel(0)).toBe("Ask Warden");
    expect(askWardenLabel(1)).toBe("Ask Warden · 1 message");
    expect(askWardenLabel(2)).toBe("Ask Warden · 2 messages");
  });
});
