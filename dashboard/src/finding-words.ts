// A Finding's enums as the dashboard says them (GLOSSARY.md).
import type {
  AssetKind,
  Level,
  Location,
  Module,
  ProposalDecision,
  Severity,
  Status,
} from "@warden/contracts";

export const SEVERITY_WORDS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const STATUS_WORDS: Record<Status, string> = {
  open: "Open",
  fixed: "Fixed",
  accepted: "Accepted",
  false_positive: "False positive",
};

/** A Team's Level on the journey, as the Overview and the Findings page's Level line say it. */
export const LEVEL_WORDS: Record<Level, string> = {
  quick: "Quick",
  standard: "Standard",
  audit_ready: "Audit-ready",
};

export const MODULE_WORDS: Record<Module, string> = {
  guard: "Guard",
  patch: "Patch",
  vouch: "Vouch",
};

export const ASSET_KIND_WORDS: Record<AssetKind, string> = {
  repo: "Repo",
  product: "Product",
  device: "Device",
  agent_session: "Agent session",
};

/** The flag beside a Fixed Finding's Status when a Scan saw what may be the same problem moved. */
export const UNCONFIRMED_FIX = "Unconfirmed fix";

/** Where on its Asset a Finding sits: `path:line`, `package version · vulnerability`, a setting's name, or the session. */
export function locationWords(location: Location): string {
  switch (location.kind) {
    case "file":
      return location.line === undefined ? location.path : `${location.path}:${location.line}`;
    case "dependency": {
      const what = `${location.package} ${location.version}`;
      return location.vulnerability === undefined ? what : `${what} · ${location.vulnerability}`;
    }
    case "setting":
      return location.name;
    case "session":
      return "the whole session";
  }
}

export const PROPOSAL_DECISION_WORDS: Record<ProposalDecision, string> = {
  accept: "Accept",
  mark_false_positive: "Mark False positive",
};
