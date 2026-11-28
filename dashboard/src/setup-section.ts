// What each Setup section that asks Warden's server something shares with the page: Setup waits for every one to
// answer before it lands on an anchor, so a section still waiting above the heading doesn't push it away.
import { useEffect } from "react";
import type { PageProps } from "./App.tsx";

/** A Setup section that asks Warden's server something before it shows, its waiting line in its place until then. */
export type AskingSection =
  "github" | "write" | "grants" | "repos" | "catalogues" | "hook" | "judge-model";
/** Tells Setup a section's call has answered, so its waiting line is gone. */
export type OnAnswered = (section: AskingSection) => void;
export type SectionProps = PageProps & { onAnswered: OnAnswered };

/** Once `answered` first turns true, tells Setup that `section` has. */
export function useReportAnswered(
  answered: boolean,
  section: AskingSection,
  onAnswered: OnAnswered,
) {
  useEffect(() => {
    if (answered) onAnswered(section);
  }, [answered, section, onAnswered]);
}
