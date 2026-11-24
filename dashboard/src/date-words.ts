// Dates as the dashboard says them, in the reader's own locale: one place, so every page says a date the same way.

/** A date-time's day: "Nov 24, 2026" (in an English locale). */
export const dayWords = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** A date-time's day and time: "Nov 24, 2026, 9:14 AM" (in an English locale). */
export const dayAndTimeWords = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
