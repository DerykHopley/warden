# Modules write Findings; only Vouch computes Gaps

Every module writes problems in one shared Finding format: one problem, one Asset, one Rule, with a Status that
only a Scan sets to Fixed. Vouch reads Findings as evidence, judges each Control as a Verdict, and computes Gaps
from reviewed Verdicts. Gaps have no Status of their own and nothing else writes them, so there is one place where
compliance is decided and no second lifecycle to keep in step. Risk is accepted on Findings, never on a Gap.

## Consequences

- Patch's hand-set "fixed" is dropped; "not affected" becomes Accepted with that reason.
- Vouch's per-Control result is called a Verdict, never a finding.
