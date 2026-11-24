// The Ask Warden panel's rules below the UI: its starting state by window width and a person's stored choice, how it
// shows at each width, its context line, and its closed button's words.
import { describe, expect, it } from "vitest";
import {
  askWardenLabel,
  contextLine,
  findingsViewWords,
  panelShownAs,
  startingPanel,
} from "../src/panel.ts";
import { finding } from "./findings-fixture.ts";

const stored = (value: unknown) => JSON.stringify(value);
const noop = () => {};

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

describe("the context line", () => {
  it("with a focus: the Finding's short id, then the view", () => {
    const focus = finding("3f9a1c2e-0000-4000-8000-000000000001");
    expect(
      contextLine({
        view: findingsViewWords({ status: "open", severity: "high", module: "all" }),
        focus,
        clearFocus: noop,
      }),
    ).toBe("Talking about: 3f9a1c2e · view: Findings, Open, High");
  });

  it("without a focus: the view alone", () => {
    expect(
      contextLine({
        view: findingsViewWords({ status: "open", severity: "all", module: "all" }),
        focus: null,
        clearFocus: noop,
      }),
    ).toBe("Talking about: view: Findings, Open");
    expect(contextLine({ view: ["People"], focus: null, clearFocus: noop })).toBe(
      "Talking about: view: People",
    );
  });

  it("names each filter that isn't all, in the order status, severity, module, in the dashboard's words", () => {
    expect(
      findingsViewWords({ status: "false_positive", severity: "critical", module: "patch" }),
    ).toEqual(["Findings", "False positive", "Critical", "Patch"]);
    expect(findingsViewWords({ status: "all", severity: "all", module: "guard" })).toEqual([
      "Findings",
      "Guard",
    ]);
  });
});

describe("the closed panel's button", () => {
  it("reads Ask Warden, then the count of sent messages once there are any", () => {
    expect(askWardenLabel(0)).toBe("Ask Warden");
    expect(askWardenLabel(1)).toBe("Ask Warden · 1 message");
    expect(askWardenLabel(2)).toBe("Ask Warden · 2 messages");
  });
});
