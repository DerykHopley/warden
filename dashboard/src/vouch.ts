// Vouch's Catalogues (spec #341, slice 5): the calls Setup's Catalogues section makes, reading every Catalogue as the
// Team sees it and an Admin's switch turning one on or off, and the watch that rereads them after a switch a Team
// switch dropped.
import { CataloguesBody, TeamCatalogue, type CatalogueId } from "@warden/contracts";
import { callWarden, parsed, serverError, type GetToken, type Refused } from "./api.ts";

/** 403 and 409 on a Team's call, read as every page reads them. */
type TeamRefusal = { kind: "no-team" } | { kind: "team-not-opened" };

export type CataloguesResult =
  { kind: "catalogues"; catalogues: TeamCatalogue[] } | TeamRefusal | Refused;

/** `GET /api/vouch/catalogues`: every Catalogue Warden has, as the Team sees it, read by anyone in it. */
export async function fetchCatalogues(getToken: GetToken): Promise<CataloguesResult> {
  const res = await callWarden(getToken, "/api/vouch/catalogues");
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "no-team" };
  if (res.status === 409) return { kind: "team-not-opened" };
  const body = await parsed(res, CataloguesBody);
  return body === undefined
    ? { kind: "not-answering" }
    : { kind: "catalogues", catalogues: body.catalogues };
}

export type SwitchResult =
  | { kind: "switched"; catalogue: TeamCatalogue }
  /** 403: the person isn't an Admin (any more), or has no Team. */
  | { kind: "forbidden" }
  /** 400 or 404: nothing was changed, in the server's words. */
  | { kind: "refused"; words: string }
  | { kind: "team-not-opened" }
  | Refused;

/** `PUT /api/vouch/catalogues/:id` (an Admin's): turns the Catalogue on or off for the Team. */
export async function switchCatalogue(
  getToken: GetToken,
  id: CatalogueId,
  on: boolean,
): Promise<SwitchResult> {
  const res = await callWarden(getToken, `/api/vouch/catalogues/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { on },
  });
  if (!(res instanceof Response)) return res;
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 400 || res.status === 404) {
    return { kind: "refused", words: (await serverError(res)) ?? "Nothing was changed." };
  }
  if (res.status === 409) return { kind: "team-not-opened" };
  const catalogue = await parsed(res, TeamCatalogue);
  return catalogue === undefined ? { kind: "not-answering" } : { kind: "switched", catalogue };
}

/** The Setup pages shown now, each told when a dropped switch changed a Team's Catalogues. */
const cataloguesWatchers = new Set<(team: string | null) => void>();

/**
 * Calls `watcher` with the Team whenever a switch a Team switch dropped changed that Team's Catalogues; it returns the
 * call that stops it. A Team switch mounts a fresh Setup page, so the page that sent a switch may be gone by the time
 * its answer arrives: the page shown then is the one that reads the Catalogues again.
 */
export function watchCatalogues(watcher: (team: string | null) => void): () => void {
  cataloguesWatchers.add(watcher);
  return () => cataloguesWatchers.delete(watcher);
}

/** Tells each Setup page shown now that `team`'s Catalogues changed. */
export function cataloguesChanged(team: string | null): void {
  for (const watcher of cataloguesWatchers) watcher(team);
}
