// Patch's CVSS band map (GLOSSARY Severity: "Patch maps CVSS bands onto it"; spec #101). A CVSS base score of 9.0 or
// more is Critical, 7.0 or more High, 4.0 or more Medium, below that Low. With no score, NVD's own severity word is
// used. With neither, the CVE is Medium and not scored, so the summary can say "not scored yet".
import type { Severity } from "@warden/contracts";

export interface CvssSeverity {
  readonly severity: Severity;
  readonly scored: boolean;
}

/** NVD's four severity words. NVD also sends NONE, or nothing, for a CVE it hasn't scored. */
export type NvdSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const NVD_SEVERITY: Readonly<Record<NvdSeverity, Severity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/** One of NVD's four severity words; NONE, null and anything else are not. */
export function isNvdSeverity(word: string | null): word is NvdSeverity {
  return word !== null && Object.hasOwn(NVD_SEVERITY, word);
}

/** A score that isn't a number from 0 to 10 counts as no score; an NVD severity other than the four words as none. */
export function cvssSeverity(score: number | null, nvdSeverity: string | null): CvssSeverity {
  if (score !== null && Number.isFinite(score) && score >= 0 && score <= 10) {
    if (score >= 9.0) return { severity: "critical", scored: true };
    if (score >= 7.0) return { severity: "high", scored: true };
    if (score >= 4.0) return { severity: "medium", scored: true };
    return { severity: "low", scored: true };
  }
  return isNvdSeverity(nvdSeverity)
    ? { severity: NVD_SEVERITY[nvdSeverity], scored: true }
    : { severity: "medium", scored: false };
}
