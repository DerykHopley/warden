// Where text sits in a file's text, for tests that check an Observation's line.

/** The line (from 1) of `text` the first `needle` is on. */
export const lineWith = (text: string, needle: string) =>
  text.split("\n").findIndex((line) => line.includes(needle)) + 1;
