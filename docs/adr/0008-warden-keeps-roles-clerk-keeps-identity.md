# Warden keeps Roles; Clerk keeps identity

Clerk signs people in and says which Team (Clerk Organization) they belong to. Warden's own database holds each
person's Role in a Team (Member, Lead or Admin), under the same row-level security as every other Team-owned table
(ADR 0006), and every request that changes data checks it on the server. A Warden Admin is also made an `org:admin`
in Clerk so they can manage invitations; Warden's backend keeps that in step whenever an Admin changes a Role.

## Why

Clerk Organizations come with two roles, `org:admin` and `org:member`. A third (Lead) needs Clerk's paid B2B add-on
in production, about $100 a month (clerk.com, checked 2026-11-24). Keeping Roles in Warden costs nothing, keeps the
check in Warden's own database, and gives an append-only history of every Role change (who gave whom which Role,
when), which is evidence for VDA ISA2027 4.2.1, access rights reviewed regularly.

## Considered options

- **Clerk custom roles** (the add-on): a new paid service for one role.
- **The Role in Clerk's membership metadata**, as Vouch did with user metadata: free, but every check asks Clerk, and
  the history of changes lives outside Warden.

## Consequences

- A Clerk Organization holds up to 20 members without the add-on; Warden raises the limit from 5 to 20. A larger
  Team is later work.
- Later, and not decided: managing Teams inside Warden, and taking Roles from a company directory (Active Directory,
  Entra ID or another SSO source). Roles living in Warden's database makes either a new source, not a rewrite.
- A Proposal keeps who asked for it and who approved it, so a later four-eyes rule (a second Lead for Critical
  Findings) needs no change to stored data.
