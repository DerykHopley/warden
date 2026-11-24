// @vitest-environment node
// Clerk's screens speak Warden's words: a Team, never an "organization" (GLOSSARY.md).
import { describe, expect, it } from "vitest";
import { localization } from "../src/clerk-setup.ts";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("Clerk localization", () => {
  it("names the switcher's create and manage actions for a Team", () => {
    expect(localization.organizationSwitcher.action__createOrganization).toBe("Create Team");
    expect(localization.createOrganization.title).toBe("Create Team");
    expect(localization.organizationProfile.navbar.title).toBe("Team");
  });

  it("never says organization, outside Clerk's own {{placeholders}}", () => {
    const all = strings(localization).map((s) => s.replace(/{{\w+}}/g, ""));
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((s) => /organi[sz]ation/i.test(s))).toEqual([]);
  });

  // Deleting a Team isn't built (#6), and Clerk's org:admin role can't delete an Organization, so Clerk's screens
  // never offer a delete in Warden's words.
  it("offers no delete: no delete string and no deleteOrganization key", () => {
    expect(strings(localization).filter((s) => /delet/i.test(s))).toEqual([]);
    expect(JSON.stringify(localization)).not.toContain("deleteOrganization");
  });
});
