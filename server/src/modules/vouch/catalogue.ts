// The VDA ISA 2027.1 Catalogue (GLOSSARY: Catalogue, Control), held as files in ./vda-isa-2027.1 rather than a table:
// its text is the same for every Team. `controls.yaml` and `controls-de.yaml` are the original Vouch's, byte for byte;
// `controls-added.yaml` and `controls-added-de.yaml` hold 1.3.3 and 1.3.4, extracted from the same xlsx files by
// `isa-extract.ts`. The licence and credit are in NOTICE.md beside them. The server reads the English YAML only; the
// xlsx files are read by the extraction and its tests, never at run time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogueId } from "@warden/contracts";
import { parse } from "yaml";
import { z } from "zod";

/** Where the Catalogue's files live, here and in the image. */
export const CATALOGUE_FOLDER = fileURLToPath(new URL("./vda-isa-2027.1", import.meta.url));

/** The English controls files the server reads: the original's twelve, then the two Warden added. */
export const CONTROLS_FILES = ["controls.yaml", "controls-added.yaml"] as const;

/** The ISA's requirement columns, in the xlsx's order. */
export const REQUIREMENT_COLUMNS = ["must", "should", "high", "very high"] as const;
export type RequirementColumn = (typeof REQUIREMENT_COLUMNS)[number];

const isaText = z.string().min(1);

const Control = z.object({
  id: z.string().regex(/^\d+(\.\d+)+$/, "a control id is dotted numbers, such as 1.3.3"),
  question: isaText,
  iso_27001: isaText,
  requirements: z.array(
    z.object({ id: z.string().min(1), column: z.enum(REQUIREMENT_COLUMNS), text: isaText }),
  ),
});
/** One Control, its text unchanged from the ISA; `id` and each requirement's `id` and `column` are Warden's. */
export type Control = z.infer<typeof Control>;

/** A controls file, as `isa-extract.ts` writes it. */
export const ControlsFile = z.object({
  source: z.literal("VDA ISA 2027.1"),
  excel: z.string().min(1),
  controls: z.array(Control),
});
export type ControlsFile = z.infer<typeof ControlsFile>;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads one controls file; throws naming the file, and the control when one fails the schema. */
function readControlsFile(folder: string, name: string): Control[] {
  let text: string;
  try {
    text = readFileSync(join(folder, name), "utf8");
  } catch (error) {
    throw new Error(`Catalogue file ${name} can't be read: ${reasonOf(error)}`, { cause: error });
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`Catalogue file ${name} is not valid YAML: ${reasonOf(error)}`, {
      cause: error,
    });
  }
  const checked = ControlsFile.safeParse(data);
  if (checked.success) return checked.data.controls;
  const issue = checked.error.issues[0];
  const path = issue?.path ?? [];
  const [top, index, ...field] = path;
  let where = path.join(".") || "the file";
  if (top === "controls" && typeof index === "number") {
    // The issue is inside one control, so `controls` is an array: name the control by its id when it has one.
    const control = (data as { controls: unknown[] }).controls[index] as { id?: unknown } | null;
    const id = typeof control?.id === "string" ? control.id : `#${index + 1}`;
    where = `control ${id}${field.length > 0 ? `, ${field.join(".")}` : ""}`;
  }
  throw new Error(`Catalogue file ${name}: ${where}: ${issue?.message ?? "invalid"}`);
}

/** Orders dotted ids by number: 1.3.4 before 1.6.1, and 1.10.1 after 1.9.1. */
function byControlId(a: Control, b: Control): number {
  const left = a.id.split(".").map(Number);
  const right = b.id.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? -1) - (right[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Every Control of VDA ISA 2027.1 in English, in id order, from the folder's controls files. A missing file, a YAML
 * error, a control that fails the schema, or one held twice throws an error naming the file (and the control).
 */
export function loadCatalogue(folder: string = CATALOGUE_FOLDER): Control[] {
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const name of CONTROLS_FILES) {
    for (const control of readControlsFile(folder, name)) {
      if (seen.has(control.id)) {
        throw new Error(`Catalogue file ${name}: control ${control.id} appears more than once`);
      }
      seen.add(control.id);
      controls.push(control);
    }
  }
  return controls.sort(byControlId);
}

/** A published, versioned set of Controls, with the ones Vouch judges now. */
export type Catalogue = {
  id: CatalogueId;
  name: string;
  /** The version's publication date, YYYY-MM-DD. */
  date: string;
  /** The rights holder's credit line, from NOTICE.md's Credit section. */
  credit: string;
  licence: { name: string; url: string };
  /** The Controls Vouch gives a Verdict, in the order it shows them. The others stay in the data, unjudged. */
  judgedControls: readonly Control[];
};

/** The Controls of VDA ISA 2027.1 that have Rules (or the Judge's Spot run) to evidence them. */
const JUDGED_CONTROL_IDS = ["1.3.3", "1.3.4", "4.1.3", "5.2.4"] as const;

function judgedControls(controls: readonly Control[]): Control[] {
  return JUDGED_CONTROL_IDS.map((id) => {
    const control = controls.find((candidate) => candidate.id === id);
    if (control === undefined) throw new Error(`the VDA ISA 2027.1 Catalogue has no control ${id}`);
    return control;
  });
}

export const VDA_ISA_2027_1: Catalogue = {
  id: "vda-isa-2027.1",
  name: "VDA ISA 2027.1",
  date: "2026-09-30",
  credit:
    "© 2026 ENX Association, an Association according to the French Law of 1901, registered under No. w923004198 " +
    "at the Sous-préfecture of Boulogne-Billancourt, France.",
  licence: { name: "CC BY-ND 4.0", url: "https://creativecommons.org/licenses/by-nd/4.0/" },
  judgedControls: judgedControls(loadCatalogue()),
};
