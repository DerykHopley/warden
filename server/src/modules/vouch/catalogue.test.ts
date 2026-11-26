import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CATALOGUE_FOLDER, type ControlsFile, loadCatalogue, VDA_ISA_2027_1 } from "./catalogue.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const read = (name: string) => readFile(join(CATALOGUE_FOLDER, name));

describe("the Catalogue folder", () => {
  it.each([
    ["controls.yaml", "3c06f20f7770fb0f974b2d460e28fd6e9c571bfd4009f2702d2be2769cee1f7b"],
    ["controls-de.yaml", "e4d7bc239f695835a659f8121a29baf6c7b34ba40763aac4d79bac1b6b866520"],
    ["isa2027.1-en.xlsx", "0e4ca80054a65e861e4b0b07a6afbe71f5b5c60f52b6f1eb4d43d53b92de6b1f"],
    ["isa2027.1-de.xlsx", "bb0e2cf455c89143e791ce9d22afa9f2c787fcd4697d9ee4bd128086948c4d2f"],
  ])("carries %s byte for byte from the original Vouch", async (name, hash) => {
    expect(sha256(await read(name))).toBe(hash);
  });

  it("keeps the original NOTICE.md unchanged at its start, then lists the added controls", async () => {
    const notice = await read("NOTICE.md");
    const ORIGINAL_LENGTH = 3584;

    expect(sha256(notice.subarray(0, ORIGINAL_LENGTH))).toBe(
      "a743fb14b4a883cc3a8d2ab1000c300eba3fc196f0362040b0c5b53fe86d76aa",
    );
    const added = notice.subarray(ORIGINAL_LENGTH).toString("utf8");
    expect(added).toContain("1.3.3");
    expect(added).toContain("1.3.4");
    expect(added).toContain("`controls-added.yaml`");
    expect(added).toContain("`controls-added-de.yaml`");
    expect(added).toContain(
      "not connected with, sponsored or endorsed by the ENX Association or the VDA",
    );
  });
});

describe("loadCatalogue", () => {
  it("answers the fourteen controls: the twelve carried and 1.3.3 and 1.3.4, in id order", () => {
    expect(loadCatalogue().map((control) => control.id)).toEqual([
      "1.1.1",
      "1.3.3",
      "1.3.4",
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
    ]);
  });

  describe("with a broken controls file", () => {
    let folder: string;

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), "warden-catalogue-"));
      for (const name of ["controls.yaml", "controls-added.yaml"]) {
        await copyFile(join(CATALOGUE_FOLDER, name), join(folder, name));
      }
    });

    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it("loads the copies as it loads the folder", () => {
      expect(loadCatalogue(folder)).toEqual(loadCatalogue());
    });

    it("throws naming a missing file", async () => {
      await rm(join(folder, "controls-added.yaml"));

      expect(() => loadCatalogue(folder)).toThrow(/controls-added\.yaml/);
    });

    it("throws naming a file that isn't YAML", async () => {
      await writeFile(join(folder, "controls.yaml"), "controls: [\n  - id: 1.1.1\n  question: {");

      expect(() => loadCatalogue(folder)).toThrow(/controls\.yaml.*YAML/s);
    });

    it("throws naming the file and the control missing its question", async () => {
      const text = await readFile(join(folder, "controls-added.yaml"), "utf8");
      const data = parse(text) as ControlsFile;
      const [first, second] = data.controls;
      if (first === undefined || second === undefined)
        throw new Error("the added file has two controls");
      await writeFile(
        join(folder, "controls-added.yaml"),
        JSON.stringify({ ...data, controls: [first, { ...second, question: undefined }] }),
      );

      expect(() => loadCatalogue(folder)).toThrow(
        /controls-added\.yaml.*control 1\.3\.4.*question/,
      );
    });

    it("throws naming a control both files hold", async () => {
      const carried = parse(await readFile(join(folder, "controls.yaml"), "utf8")) as ControlsFile;
      const added = parse(
        await readFile(join(folder, "controls-added.yaml"), "utf8"),
      ) as ControlsFile;
      await writeFile(
        join(folder, "controls-added.yaml"),
        JSON.stringify({ ...added, controls: [...added.controls, carried.controls[0]] }),
      );

      expect(() => loadCatalogue(folder)).toThrow(
        /controls-added\.yaml.*control 1\.1\.1.*more than once/,
      );
    });
  });
});

describe("VDA_ISA_2027_1", () => {
  it("names the Catalogue, its date, its licence and its credit", () => {
    expect(VDA_ISA_2027_1).toMatchObject({
      id: "vda-isa-2027.1",
      name: "VDA ISA 2027.1",
      date: "2026-09-30",
      licence: { name: "CC BY-ND 4.0", url: "https://creativecommons.org/licenses/by-nd/4.0/" },
    });
  });

  it("takes its credit line from NOTICE.md's Credit section", async () => {
    const notice = (await read("NOTICE.md")).toString("utf8");
    const credit = notice.split("## Credit\n\n")[1]?.split("\n\n")[0];

    expect(VDA_ISA_2027_1.credit).toBe(credit);
    expect(VDA_ISA_2027_1.credit).toMatch(/^© 2026 ENX Association/);
  });

  it("judges exactly 1.3.3, 1.3.4, 4.1.3 and 5.2.4, in that order, with the English file's text", async () => {
    const english = [
      ...(parse((await read("controls.yaml")).toString("utf8")) as ControlsFile).controls,
      ...(parse((await read("controls-added.yaml")).toString("utf8")) as ControlsFile).controls,
    ];
    const englishControl = (id: string) => english.find((control) => control.id === id);

    expect(VDA_ISA_2027_1.judgedControls.map((control) => control.id)).toEqual([
      "1.3.3",
      "1.3.4",
      "4.1.3",
      "5.2.4",
    ]);
    for (const control of VDA_ISA_2027_1.judgedControls) {
      expect(control.question).toBe(englishControl(control.id)?.question);
      expect(control.iso_27001).toBe(englishControl(control.id)?.iso_27001);
      expect(control.iso_27001).toContain("27001");
    }
  });
});
