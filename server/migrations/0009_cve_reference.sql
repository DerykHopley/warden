-- Patch's CVE snapshot (spec #101, story 10): public reference data, the same for every Team, so not Team-owned and
-- under no row-level security (`NOT_TEAM_DATA` in server/src/unprotected-tables.ts names each table, with why). The
-- loader (server/src/modules/patch/cve-snapshot.ts) fills them from the files shipped in the Patch module, running
-- as warden_migrate, which owns them and is the only role that writes them. warden_app reads them; warden_admin gets
-- nothing, as 0006_proposals left it (it reads only `teams (id)`).

-- The snapshot loaded now: one row. `digest` is the SHA-256 of the five files, so a second load of the same files
-- does nothing.
create table cve_snapshot (
  only_row boolean primary key default true check (only_row),
  as_of date not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  loaded_at timestamptz not null default now()
);

-- Each source's manifest entry: its licence and attribution, which the README repeats, and NVD's notice.
create table cve_sources (
  id text primary key check (id ~ '\S'),
  name text not null check (name ~ '\S'),
  licence text not null check (licence ~ '\S'),
  attribution text not null check (attribution ~ '\S'),
  notice text,
  url text not null,
  retrieved date not null,
  as_of date,
  count integer not null check (count >= 0)
);

-- NVD's CVEs matched to Patch's 12 frameworks. `product` is a framework id (PATCH_FRAMEWORKS) and `product_source` how
-- it was matched. Severity is NVD's as the data gives it, `NONE` and null included; `cvss` is the base score or null.
create table cves (
  id text primary key check (id ~ '^CVE-[0-9]{4}-[0-9]+$'),
  product text not null check (product ~ '\S'),
  product_source text not null check (product_source in ('text', 'cpe')),
  published date not null,
  severity text check (severity in ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  cvss double precision check (cvss between 0 and 10),
  cwes text[] not null,
  description text not null,
  url text not null
);

-- CISA's Known Exploited Vulnerabilities entries for those CVEs.
create table cve_kev (
  cve_id text primary key references cves (id),
  name text not null,
  date_added date not null,
  due_date date not null,
  ransomware_use text not null,
  required_action text not null
);

-- FIRST's EPSS score and percentile for each CVE, on its date.
create table cve_epss (
  cve_id text primary key references cves (id),
  score double precision not null check (score between 0 and 1),
  percentile double precision not null check (percentile between 0 and 1),
  date date not null
);

-- OSV's affected ranges, one row per OSV entry. `position` is the entry's place in osv.json, so a CVE's entries keep
-- OSV's order (the verdict's reasons and fixes depend on it); `ranges` is OSV's list as JSON, in its order.
create table cve_osv (
  position integer primary key check (position >= 0),
  cve_id text not null references cves (id),
  product text not null check (product ~ '\S'),
  ecosystem text not null check (ecosystem ~ '\S'),
  package text not null check (package ~ '\S'),
  advisory text not null,
  ranges jsonb not null check (jsonb_typeof(ranges) = 'array'),
  fixed text[] not null
);

create index cve_osv_cve_id on cve_osv (cve_id, position);

-- 0001's default grants gave warden_app every write: only the loader writes these.
revoke insert, update, delete, truncate
  on cve_snapshot, cve_sources, cves, cve_kev, cve_epss, cve_osv
  from warden_app;
