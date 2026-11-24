// Patch's "may have moved" rule (ADR 0005, GLOSSARY Unconfirmed fix): the same CVE under a different package, on the
// same Asset and under the same Rule. A dependency with no vulnerability named never matches: there is no CVE to follow.
import { sameAsset, type MoveRule } from "../../findings/index.ts";

export const patchMoveRule: MoveRule = (fixed, opened) =>
  fixed.rule_id === opened.rule_id &&
  sameAsset(fixed.asset, opened.asset) &&
  fixed.location.kind === "dependency" &&
  opened.location.kind === "dependency" &&
  fixed.location.vulnerability !== undefined &&
  fixed.location.vulnerability === opened.location.vulnerability &&
  fixed.location.package !== opened.location.package;
