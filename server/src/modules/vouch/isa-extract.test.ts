import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readSheet } from "read-excel-file/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CATALOGUE_FOLDER } from "./catalogue.ts";
import {
  CARRIED_CONTROL_IDS,
  COL_ID,
  COL_QUESTION,
  COL_STANDARDS,
  EDITIONS,
  extract,
  type Language,
  readEditionRows,
  REQUIREMENT_COL,
  writeAddedControls,
} from "./isa-extract.ts";

const LANGUAGES: Language[] = ["en", "de"];
const CARRIED_FILE = { en: "controls.yaml", de: "controls-de.yaml" } as const;
const ADDED_FILE = { en: "controls-added.yaml", de: "controls-added-de.yaml" } as const;

const readText = (name: string) => readFile(join(CATALOGUE_FOLDER, name), "utf8");

/** The edition's sheet as the xlsx holds it, untrimmed, by control id. */
async function rawRows(language: Language) {
  const rows = await readEditionRows(CATALOGUE_FOLDER, language);
  return new Map(rows.map((row) => [row[COL_ID], row]));
}

describe("readEditionRows", () => {
  it("reads each cell as read-excel-file does, but for XML's reading of a CR LF line break as LF", async () => {
    const edition = EDITIONS.en;
    const raw = await readSheet(join(CATALOGUE_FOLDER, edition.excel), edition.sheet, {
      trim: false,
    });
    const rows = await readEditionRows(CATALOGUE_FOLDER, "en");

    expect(
      rows.map((row) =>
        row.map((cell) => (typeof cell === "string" ? cell.replaceAll("\n", "\r\n") : cell)),
      ),
    ).toEqual(raw);
    expect(rows.flat().some((cell) => typeof cell === "string" && cell.includes("\r"))).toBe(false);
  });
});

describe.each(LANGUAGES)("the %s edition's extraction", (language) => {
  it("gives the carried twelve controls exactly as the original's controls file holds them", async () => {
    const carried: unknown = parse(await readText(CARRIED_FILE[language]));

    expect(await extract(CATALOGUE_FOLDER, language, CARRIED_CONTROL_IDS)).toEqual(carried);
  });

  it("keeps each added question and requirement text verbatim from its xlsx cell", async () => {
    const rows = await rawRows(language);
    const added = parse(await readText(ADDED_FILE[language])) as Awaited<
      ReturnType<typeof extract>
    >;

    for (const control of added.controls) {
      const row = rows.get(control.id);
      expect(row, control.id).toBeDefined();
      expect(control.question).toBe(row?.[COL_QUESTION]);
      expect(String(row?.[COL_STANDARDS])).toContain(control.iso_27001);
      expect(control.requirements.length, control.id).toBeGreaterThan(0);
      for (const requirement of control.requirements) {
        const cell = String(row?.[REQUIREMENT_COL[requirement.column]]);
        expect(cell, `${control.id} ${requirement.id}`).toContain(`+ ${requirement.text}`);
      }
    }
  });
});

describe("writeAddedControls", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "warden-isa-"));
    for (const language of LANGUAGES) {
      const excel = EDITIONS[language].excel;
      await copyFile(join(CATALOGUE_FOLDER, excel), join(folder, excel));
    }
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  /** Rewrites the copy's shared strings, where the sheet's text cells live. */
  async function alterSharedStrings(language: Language, alter: (xml: string) => string) {
    const path = join(folder, EDITIONS[language].excel);
    const entries = unzipSync(await readFile(path));
    const name = "xl/sharedStrings.xml";
    const before = strFromU8(entries[name] ?? new Uint8Array());
    const after = alter(before);
    expect(after).not.toBe(before);
    entries[name] = strToU8(after);
    await writeFile(path, zipSync(entries));
  }

  const swap = (a: string, b: string) => (xml: string) =>
    xml
      .replace(`<t>${a}</t>`, "\0")
      .replace(`<t>${b}</t>`, `<t>${a}</t>`)
      .replace("\0", `<t>${b}</t>`);

  const yamlFiles = async () => (await readdir(folder)).filter((name) => name.endsWith(".yaml"));

  it("writes both added files from the folder's xlsx files", async () => {
    await writeAddedControls(folder);

    expect((await yamlFiles()).sort()).toEqual(["controls-added-de.yaml", "controls-added.yaml"]);
    for (const language of LANGUAGES) {
      expect(await readFile(join(folder, ADDED_FILE[language]), "utf8")).toBe(
        await readText(ADDED_FILE[language]),
      );
    }
  });

  it("refuses an English xlsx whose columns moved, naming the header, and writes no file", async () => {
    await alterSharedStrings("en", swap("Control question", "Reference to other standards"));

    await expect(writeAddedControls(folder)).rejects.toThrow(
      /isa2027\.1-en\.xlsx.*expected header "Control question" in column 8, found "Reference to other standards"/,
    );
    expect(await yamlFiles()).toEqual([]);
  });

  it("refuses a German xlsx whose columns moved, and writes neither edition", async () => {
    await alterSharedStrings("de", swap("Kontrollfrage", "Verweisung auf andere Normen"));

    await expect(writeAddedControls(folder)).rejects.toThrow(
      /isa2027\.1-de\.xlsx.*expected header "Kontrollfrage" in column 8/,
    );
    expect(await yamlFiles()).toEqual([]);
  });

  it("refuses an xlsx where a control row appears twice, naming it, and writes no file", async () => {
    await alterSharedStrings("en", (xml) => xml.replace("<t>1.3.3</t>", "<t>1.3.4</t>"));

    await expect(writeAddedControls(folder)).rejects.toThrow(
      /isa2027\.1-en\.xlsx.*control 1\.3\.4 appears more than once/,
    );
    expect(await yamlFiles()).toEqual([]);
  });

  it("refuses an xlsx with no row for a control, naming it, and writes no file", async () => {
    await alterSharedStrings("de", (xml) => xml.replace("<t>1.3.3</t>", "<t>1.3.x</t>"));

    await expect(writeAddedControls(folder)).rejects.toThrow(
      /isa2027\.1-de\.xlsx.*no row for control 1\.3\.3/,
    );
    expect(await yamlFiles()).toEqual([]);
  });
});
