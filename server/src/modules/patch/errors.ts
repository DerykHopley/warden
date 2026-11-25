/**
 * A dependency's version that its product's ecosystems can't read, so it isn't saved. Its message is for people: it
 * says why and gives an example. In place of the spike's InputError (Patch's 400 with code `bad_version`).
 */
export class VersionRefused extends Error {
  readonly code = "bad_version";

  constructor(message: string) {
    super(message);
    this.name = "VersionRefused";
  }
}

/** A Product id the Team doesn't have, another Team's included: nothing was changed (Patch's 404). */
export class ProductNotFound extends Error {
  constructor(id: string) {
    super(`No Product ${id} in this Team`);
    this.name = "ProductNotFound";
  }
}

/**
 * A Finding id that isn't one of the Team's Patch Findings: one the Team doesn't have (another Team's included),
 * another module's, or one with no CVE to assess. Its message names nothing but the id asked for.
 */
export class PatchFindingNotFound extends Error {
  constructor(id: string) {
    super(`No Patch Finding ${id} in this Team`);
    this.name = "PatchFindingNotFound";
  }
}

/** A Patch Finding whose CVE the loaded CVE snapshot doesn't hold: never loaded, or dropped by a newer one. */
export class CveNotInSnapshot extends Error {
  constructor(cveId: string) {
    super(`The CVE snapshot doesn't hold ${cveId}, so its Finding can't be assessed`);
    this.name = "CveNotInSnapshot";
  }
}

/**
 * A name another Product in the Team already has, whatever its case or the spaces around it: nothing was written
 * (Patch's 409). The unique index decides it, so two Leads saving at once get it too.
 */
export class ProductNameTaken extends Error {
  constructor(name: string) {
    super(`Another Product in this Team is already called "${name}"`);
    this.name = "ProductNameTaken";
  }
}
