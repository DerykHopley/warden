// Guard's "may have moved" rule (ADR 0005, GLOSSARY Unconfirmed fix): the same Rule on the same Asset.
import { sameAsset, type MoveRule } from "../../findings/index.ts";

export const guardMoveRule: MoveRule = (fixed, opened) =>
  fixed.rule_id === opened.rule_id && sameAsset(fixed.asset, opened.asset);
