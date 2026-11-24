import type { Location } from "./finding.ts";

/**
 * The Fingerprint: the Rule id, then where the problem sits, joined with `|`. The Asset is never part of it, a file's
 * line is left out (a problem that moves lines is the same Finding), and so is a package's version (an upgrade isn't
 * a new problem). The README states this rule for implementations in other languages.
 */
export function fingerprint(ruleId: string, location: Location): string {
  switch (location.kind) {
    case "file":
      return `${ruleId}|file:${location.path}`;
    case "dependency":
      return `${ruleId}|dependency:${location.package}|${location.vulnerability ?? ""}`;
    case "setting":
      return `${ruleId}|setting:${location.name}`;
    case "session":
      return `${ruleId}|session`;
  }
}
