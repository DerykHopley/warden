// The Team's Findings as the server stores them, and the orders and counts the Findings page shows them in.
import {
  FindingsBody,
  Severity,
  type Asset,
  type Finding,
  type FindingsView,
  type Product,
} from "@warden/contracts";
import { callWarden, parsed, type GetToken, type Refused } from "./api.ts";

export type FindingsResult =
  /** Every Finding of `team`, the Team the server answered about. */
  | { kind: "findings"; team: string; findings: Finding[] }
  /** 403: the session has no Team (its active Organization went away). */
  | { kind: "no-team" }
  /** 409: the Team's Admin hasn't opened Warden yet. */
  | { kind: "team-not-opened" }
  | Refused;

export async function fetchFindings(getToken: GetToken): Promise<FindingsResult> {
  const res = await callWarden(getToken, "/api/findings");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, FindingsBody);
  return body === undefined ? { kind: "not-answering" } : { kind: "findings", ...body };
}

const severityRank = (severity: Severity) => Severity.options.indexOf(severity);

/** Most urgent first: Critical, High, Medium, Low, then by title (ignoring case and accents), then by id. */
function byUrgency(a: Finding, b: Finding): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    a.title.localeCompare(b.title, "en", { sensitivity: "base" }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The five most urgent Open Findings: the page's "Start here". Filters never change them. */
export function topFive(findings: readonly Finding[]): Finding[] {
  return findings
    .filter((f) => f.status === "open")
    .sort(byUrgency)
    .slice(0, 5);
}

/** The Findings that match `view`'s Status, Severity and module, most urgent first. */
export function inView(findings: readonly Finding[], view: FindingsView): Finding[] {
  return findings
    .filter(
      (f) =>
        (view.status === "all" || f.status === view.status) &&
        (view.severity === "all" || f.severity === view.severity) &&
        (view.module === "all" || f.module === view.module),
    )
    .sort(byUrgency);
}

/** The page's one-line summary: "7 open Findings, 2 Critical". */
export function summaryLine(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No Findings yet: they appear after the first Scan.";
  const open = findings.filter((f) => f.status === "open");
  if (open.length === 0) return "Nothing open.";
  const critical = open.filter((f) => f.severity === "critical").length;
  const count = `${open.length} open ${open.length === 1 ? "Finding" : "Findings"}`;
  return critical === 0 ? count : `${count}, ${critical} Critical`;
}

/** A Finding's id as the page shows it: its first 8 characters (the start of its UUID). */
export const shortId = (id: string) => id.slice(0, 8);

/**
 * A Product Asset's Product name when `products` (null: not loaded, or refused) holds its id; null for any other Asset,
 * or a ref no Product has (the demo's made-up `shop`, a deleted Product).
 */
export function productName(asset: Asset, products: readonly Product[] | null): string | null {
  if (asset.kind !== "product") return null;
  return products?.find((p) => p.id === asset.ref)?.name ?? null;
}

/** An Asset's words: its Product's name (`productName`), otherwise its ref as it is. */
export const assetLabel = (asset: Asset, products: readonly Product[] | null): string =>
  productName(asset, products) ?? asset.ref;
