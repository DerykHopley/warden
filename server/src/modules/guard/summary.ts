// How a Guard Rule names things in a Finding's evidence summary: each name cut short, and only the first few named,
// so names a repo makes up (a server's key, a path) can't outgrow the evidence's 2000 characters.

/** The most characters of one name a summary shows. */
const SUMMARY_NAME_MAX = 64;
/** The most names a summary lists before counting the rest. */
const SUMMARY_NAMES_MAX = 3;

/** A name as a summary shows it: cut to `SUMMARY_NAME_MAX` characters, the last one `…`. */
const summaryName = (name: string) =>
  name.length > SUMMARY_NAME_MAX ? `${name.slice(0, SUMMARY_NAME_MAX - 1)}…` : name;

/** The first `SUMMARY_NAMES_MAX` names, each cut, joined by commas, then how many more there are: `a, b, c and 2 more`. */
export function summaryNames(names: readonly string[]): string {
  const named = names.slice(0, SUMMARY_NAMES_MAX).map(summaryName).join(", ");
  const more = names.length - SUMMARY_NAMES_MAX;
  return more > 0 ? `${named} and ${more} more` : named;
}
