// Extracts VDA ISA 2027.1 Controls from each edition's xlsx into a controls file, texts unchanged: the TypeScript port
// of the original Vouch's `vouch.isa_extract` (tc-vouch-compliance at 2a71465). The same sheet, header check, columns,
// "+" bullet split, requirement ids (M1, S1, H1, V1), "None"/"Keine" handling and ISO 27001 reference, so its
// extraction of the original's twelve controls equals the carried `controls.yaml` and `controls-de.yaml` (a test
// checks both).
//
// `node server/src/modules/vouch/isa-extract.ts [folder]` writes 1.3.3 and 1.3.4 from each edition into
// `controls-added.yaml` and `controls-added-de.yaml`, in the Catalogue folder unless another is given. It extracts
// every edition first, then writes them all, so a failing edition leaves every file as it was.
//
// `read-excel-file` is a dev dependency: only this extraction and its tests read an xlsx. The server reads the YAML
// (`catalogue.ts`), and nothing it runs imports this file.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CellValue, readSheet, type Row } from "read-excel-file/node";
import { stringify } from "yaml";
import type { Control, ControlsFile, RequirementColumn } from "./catalogue.ts";

/** The original Vouch's twelve controls, carried in `controls.yaml` and `controls-de.yaml`. */
export const CARRIED_CONTROL_IDS = [
  "1.1.1",
  "1.6.1",
  "1.6.2",
  "2.1.3",
  "4.1.2",
  "4.1.3",
  "4.2.1",
  "5.1.1",
  "5.1.2",
  "5.2.4",
  "5.2.5",
  "5.2.9",
] as const;

/** The controls Warden added, written to `controls-added.yaml` and `controls-added-de.yaml`. */
export const ADDED_CONTROL_IDS = ["1.3.3", "1.3.4"] as const;

// Columns of the "Information Security" sheet (0-based), the same in both editions; the extraction checks them
// against the edition's header row, so an edition that moves a column fails instead of shipping the wrong text.
export const COL_ID = 2;
export const COL_QUESTION = 7;
export const COL_STANDARDS = 14;
export const REQUIREMENT_COL: Readonly<Record<RequirementColumn, number>> = {
  must: 9,
  should: 10,
  high: 11,
  "very high": 12,
};

/** Each column and the letter its requirement ids start with, in the xlsx's order. */
const COLUMN_PREFIX: Readonly<Record<RequirementColumn, string>> = {
  must: "M",
  should: "S",
  high: "H",
  "very high": "V",
};

const SOURCE = "VDA ISA 2027.1";
const DEFAULT_FOLDER = fileURLToPath(new URL("./vda-isa-2027.1", import.meta.url));

export type Language = "en" | "de";

/** One language's ISA xlsx: its file, its sheet and header names, and the controls file its added controls go to. */
export type Edition = {
  excel: string;
  addedFile: string;
  sheet: string;
  /** Column and header text, as the header row holds it; COL_ID's finds the header row. */
  headers: readonly (readonly [number, string])[];
  /** What a requirement cell without bullets says. */
  noRequirement: string;
};

export const EDITIONS: Readonly<Record<Language, Edition>> = {
  en: {
    excel: "isa2027.1-en.xlsx",
    addedFile: "controls-added.yaml",
    sheet: "Information Security",
    headers: [
      [COL_ID, "Control number"],
      [COL_QUESTION, "Control question"],
      [REQUIREMENT_COL.must, "Requirements\n(must)"],
      [REQUIREMENT_COL.should, "Requirements\n(should)"],
      [REQUIREMENT_COL.high, "Additional requirements\nfor high protection needs"],
      [REQUIREMENT_COL["very high"], "Additional requirements\nfor very high protection needs"],
      [COL_STANDARDS, "Reference to other standards"],
    ],
    noRequirement: "None",
  },
  de: {
    excel: "isa2027.1-de.xlsx",
    addedFile: "controls-added-de.yaml",
    sheet: "Informationssicherheit",
    headers: [
      [COL_ID, "Kontrollnummer"],
      [COL_QUESTION, "Kontrollfrage"],
      [REQUIREMENT_COL.must, "Anforderungen \n(muss)"], // the space is the xlsx's
      [REQUIREMENT_COL.should, "Anforderungen \n(sollte)"],
      [REQUIREMENT_COL.high, "Zusatzanforderungen\nbei hohem Schutzbedarf"],
      [REQUIREMENT_COL["very high"], "Zusatzanforderungen\nbei sehr hohem Schutzbedarf"],
      [COL_STANDARDS, "Verweisung auf andere Normen"],
    ],
    noRequirement: "Keine",
  },
};

const show = (value: CellValue | null | undefined) => JSON.stringify(value ?? null);

/** Throws unless some row carries every expected header in its expected column. */
function checkHeaders(rows: readonly Row[], edition: Edition, where: string): void {
  const [, first] = edition.headers[0] ?? [COL_ID, ""];
  const headerRow = rows.find((row) => row.includes(first));
  if (headerRow === undefined) throw new Error(`${where}: no header row with ${show(first)}`);
  for (const [column, name] of edition.headers) {
    if (headerRow[column] !== name) {
      throw new Error(
        `${where}: expected header ${show(name)} in column ${column + 1}, found ${show(headerRow[column])}`,
      );
    }
  }
}

/** A cell that must hold text, or nothing. */
function textCell(value: CellValue | null | undefined, what: string): string | null {
  if (value === null || value === undefined || typeof value === "string") return value ?? null;
  throw new Error(`${what}: expected text, found ${show(value)}`);
}

/**
 * One text per "+" bullet; lines that don't start with "+" continue the bullet above. Each text is a verbatim slice
 * of the cell: only the "+ " marker and the whitespace after the bullet's last line are left out. An empty cell, or
 * one saying the edition's word for none ("None", "Keine"), has no requirements.
 */
function splitRequirements(cell: string | null, edition: Edition, what: string): string[] {
  if (cell === null || cell.trim() === edition.noRequirement) return [];
  if (!cell.startsWith("+")) {
    throw new Error(
      `${what}: the cell does not start with a '+' bullet: ${show(cell.slice(0, 40))}`,
    );
  }
  return cell.split(/\n(?=\+)/).map((part) => {
    const unmarked = part.startsWith("+") ? part.slice(1) : part;
    return (unmarked.startsWith(" ") ? unmarked.slice(1) : unmarked).trimEnd();
  });
}

/** The ISO 27001 entry of the "Reference to other standards" cell, as written. */
function iso27001Reference(cell: string | null, what: string): string {
  for (const entry of (cell ?? "").split("------")) {
    if (entry.trim().startsWith("ISO") && entry.includes("27001")) return entry.trim();
  }
  throw new Error(`${what}: no ISO 27001 reference in ${show((cell ?? "").slice(0, 40))}`);
}

/**
 * The edition's sheet in `folder`, each cell as the xlsx holds it: untrimmed, and with its line breaks as an XML
 * parser reads them. Both xlsx files write every line break as a literal CR LF, which XML 1.0 (section 2.11) reads as
 * LF, as the original's openpyxl does; read-excel-file passes the CR through, so it's normalised here. Neither file
 * holds an escaped CR (`&#13;` or `_x000D_`), the one case this would change.
 */
export async function readEditionRows(folder: string, language: Language): Promise<Row[]> {
  const edition = EDITIONS[language];
  const rows = await readSheet(join(folder, edition.excel), edition.sheet, { trim: false });
  return rows.map((row) =>
    row.map((cell) => (typeof cell === "string" ? cell.replace(/\r\n?/g, "\n") : cell)),
  );
}

/**
 * The given controls of one edition, in the order given, read from the edition's xlsx in `folder`. A moved column, or
 * a control row missing or listed twice, throws naming the xlsx, its sheet and the header or control.
 */
export async function extract(
  folder: string,
  language: Language,
  controlIds: readonly string[],
): Promise<ControlsFile> {
  const edition = EDITIONS[language];
  const where = `${edition.excel}, ${edition.sheet} sheet`;
  const rows = await readEditionRows(folder, language);
  checkHeaders(rows, edition, where);
  const rowsById = new Map<CellValue, Row>();
  for (const row of rows) {
    const id = row[COL_ID];
    if (id === null || id === undefined) continue;
    if (rowsById.has(id)) throw new Error(`${where}: control ${String(id)} appears more than once`);
    rowsById.set(id, row);
  }
  const controls = controlIds.map((id): Control => {
    const row = rowsById.get(id);
    if (row === undefined) throw new Error(`${where}: no row for control ${id}`);
    const what = `${where}, control ${id}`;
    const question = textCell(row[COL_QUESTION], `${what}, question`);
    if (question === null) throw new Error(`${what}: the question is empty`);
    const columns = Object.entries(COLUMN_PREFIX) as [RequirementColumn, string][];
    return {
      id,
      question,
      iso_27001: iso27001Reference(textCell(row[COL_STANDARDS], what), what),
      requirements: columns.flatMap(([column, prefix]) => {
        const cell = textCell(row[REQUIREMENT_COL[column]], `${what}, ${column}`);
        return splitRequirements(cell, edition, `${what}, ${column}`).map((text, n) => ({
          id: `${prefix}${n + 1}`,
          column,
          text,
        }));
      }),
    };
  });
  return { source: SOURCE, excel: edition.excel, controls };
}

/** A controls file's text: the header comment the original's files carry, then the data. */
function controlsFileText(data: ControlsFile): string {
  return (
    `# Generated by \`node server/src/modules/vouch/isa-extract.ts\` from ${data.excel}; do not edit.\n` +
    "# Texts are unchanged from the VDA ISA; licence and credit: NOTICE.md beside this file.\n" +
    stringify(data, { lineWidth: 0, indentSeq: false })
  );
}

/**
 * Extracts 1.3.3 and 1.3.4 from both editions' xlsx in `folder`, then writes each edition's added controls file
 * there. A failing edition throws before any file is written. Answers the paths written.
 */
export async function writeAddedControls(folder: string): Promise<string[]> {
  const texts: [string, string][] = [];
  for (const language of Object.keys(EDITIONS) as Language[]) {
    const data = await extract(folder, language, ADDED_CONTROL_IDS);
    texts.push([join(folder, EDITIONS[language].addedFile), controlsFileText(data)]);
  }
  for (const [path, text] of texts) await writeFile(path, text, "utf8");
  return texts.map(([path]) => path);
}

if (import.meta.main) {
  try {
    for (const path of await writeAddedControls(process.argv[2] ?? DEFAULT_FOLDER)) {
      process.stderr.write(`wrote ${path}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `extraction failed; no file written: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
