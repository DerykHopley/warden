// A Finding's enums as the dashboard says them (GLOSSARY.md).
import type { AssetKind, Module, Severity, Status } from "@warden/contracts";

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
