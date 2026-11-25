import type { Finding } from "@warden/contracts";
import { SEVERITY_WORDS } from "./finding-words.ts";

/** A Severity pill: its word in the Severity's colour on its tint, never the colour alone. */
export function SeverityPill({ finding }: { finding: Finding }) {
  return (
    <span className={`sev-pill sev-${finding.severity}`}>{SEVERITY_WORDS[finding.severity]}</span>
  );
}
