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
