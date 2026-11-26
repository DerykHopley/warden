// Vouch's Catalogues as the API answers and takes them (spec #341, slice 1b): every Catalogue Warden has, whether the
// Team has it on, and its judged Controls. The Team comes from the session, never the body. The Catalogue's text is
// the rights holder's: the credit and licence go wherever it is shown (CC BY-ND 4.0).
import { z } from "zod";

/**
 * The Catalogues Warden has, by id. The one place they live: the Vouch module's Catalogues and the database's check
 * constraint on `team_catalogues.catalogue` follow this list.
 */
export const CatalogueId = z.enum(["vda-isa-2027.1"]);
export type CatalogueId = z.infer<typeof CatalogueId>;

/**
 * Vouch's judgement of one Control (GLOSSARY: Verdict), worked out from the Team's Findings, Scan coverage and Judge
 * Spot runs. A Lead's override to not applicable joins it with the review log (spec #341, slice 3).
 */
export const Verdict = z.enum(["evidenced", "partly_evidenced", "not_evidenced"]);
export type Verdict = z.infer<typeof Verdict>;

/** One judged Control, its text unchanged from the Catalogue: its ref, its question and its ISO 27001 reference. */
export const CatalogueControl = z.object({
  /** The Control's number in its Catalogue, such as 1.3.3. */
  ref: z.string().min(1),
  question: z.string().min(1),
  iso_27001: z.string().min(1),
});
export type CatalogueControl = z.infer<typeof CatalogueControl>;

/**
 * One Catalogue as the Team sees it: what it is, its credit and licence, whether it is on for the Team, who set it (an
 * Admin's Clerk user id) and when (both null when no Admin ever set it, and it is off), and the Controls Vouch judges.
 * `PUT /api/vouch/catalogues/:id` answers the Catalogue it changed in this shape.
 */
export const TeamCatalogue = z.object({
  id: CatalogueId,
  name: z.string().min(1),
  /** The version's publication date. */
  date: z.iso.date(),
  credit: z.string().min(1),
  licence: z.string().min(1),
  licence_url: z.url(),
  on: z.boolean(),
  set_by: z.string().min(1).nullable(),
  set_at: z.iso.datetime().nullable(),
  /** Only the Controls Vouch gives a Verdict, in the order it shows them; the rest of the Catalogue waits. */
  controls: z.array(CatalogueControl),
});
export type TeamCatalogue = z.infer<typeof TeamCatalogue>;

/** `GET /api/vouch/catalogues`: every Catalogue Warden has, as the Team sees it. Any person in the Team reads it. */
export const CataloguesBody = z.object({ catalogues: z.array(TeamCatalogue) });
export type CataloguesBody = z.infer<typeof CataloguesBody>;

/** `PUT /api/vouch/catalogues/:id`'s body (Admin): turn the Catalogue on or off for the Team. Nothing else. */
export const CatalogueSwitchBody = z.strictObject({ on: z.boolean() });
export type CatalogueSwitchBody = z.infer<typeof CatalogueSwitchBody>;
