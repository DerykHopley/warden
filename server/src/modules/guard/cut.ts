// Text cut to a length the contracts hold (spec #225, slice 5a): the Judge's masked events and its Findings' summaries.

/**
 * `text` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair: a lone half is refused by
 * Postgres's jsonb, where a Finding's evidence is stored.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
  return text.slice(0, end);
}
