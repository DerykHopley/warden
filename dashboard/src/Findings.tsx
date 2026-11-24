// The Findings page (story 9, docs/design.md direction E): a one-line summary, the five most urgent Open Findings as
// cards ("Start here"), then every Finding that matches the view in a table, with filter tabs. The view lives in the
// URL: a filter pushes a history entry, so Back and Forward step through views; selecting a Finding replaces the
// entry, so a reload or a shared link selects it again.
import { FindingsView, findingsViewPath, Module, Severity, type Finding } from "@warden/contracts";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { TEAM_NOT_OPENED } from "./api.ts";
import type { PageProps } from "./App.tsx";
import {
  ASSET_KIND_WORDS,
  MODULE_WORDS,
  SEVERITY_WORDS,
  STATUS_WORDS,
  UNCONFIRMED_FIX,
} from "./finding-words.ts";
import {
  fetchFindings,
  inView,
  shortId,
  summaryLine,
  topFive,
  type FindingsResult,
} from "./findings.ts";
import { CallRefused, useWardenCall } from "./warden-call.tsx";

/** The view the address bar's query names; a value it doesn't know reads as that field's default. */
const viewInAddress = () =>
  FindingsView.parse(Object.fromEntries(new URLSearchParams(location.search)));

const here = () => location.pathname + location.search;

type Choice<V> = { value: V; label: string };

// The order the page offers them in: Open first, as the default.
const STATUS_CHOICES: Choice<FindingsView["status"]>[] = [
  { value: "open", label: STATUS_WORDS.open },
  { value: "accepted", label: STATUS_WORDS.accepted },
  { value: "fixed", label: STATUS_WORDS.fixed },
  { value: "false_positive", label: STATUS_WORDS.false_positive },
  { value: "all", label: "Every status" },
];
const SEVERITY_CHOICES: Choice<FindingsView["severity"]>[] = [
  { value: "all", label: "Any severity" },
  ...Severity.options.map((value) => ({ value, label: SEVERITY_WORDS[value] })),
];
const MODULE_CHOICES: Choice<FindingsView["module"]>[] = [
  { value: "all", label: "Any module" },
  ...Module.options.map((value) => ({ value, label: MODULE_WORDS[value] })),
];

export function FindingsPage({ getToken, onSessionEnded }: PageProps) {
  const listFindings = useCallback(() => fetchFindings(getToken), [getToken]);
  const list = useWardenCall<FindingsResult>(listFindings, onSessionEnded);
  const [view, setView] = useState(viewInAddress);

  // Back and Forward bring back the view their entry's address names.
  useEffect(() => {
    const onPopState = () => setView(viewInAddress());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const findings =
    list.result !== "loading" && list.result.kind === "findings" ? list.result.findings : null;
  // A focused id the Team's list doesn't have selects nothing; until the list arrives it's kept as the address has it.
  const focused =
    findings === null || findings.some((f) => f.id === view.finding) ? view.finding : undefined;
  const shown: FindingsView = { ...view, finding: focused };
  const path = findingsViewPath(shown);

  // The address bar always reads the view as findingsViewPath writes it: a value it didn't know, or an id the Team
  // doesn't have, is rewritten in place, so it doesn't stay in history.
  useEffect(() => {
    if (here() !== path) history.replaceState(null, "", path);
  }, [path]);

  /** A filter tab: a new history entry, and the table swaps at once. */
  function choose(change: Partial<FindingsView>) {
    const next = { ...shown, ...change };
    history.pushState(null, "", findingsViewPath(next));
    setView(next);
  }

  /** Selecting a Finding replaces the address's entry (the effect above writes it). */
  const select = (id: string) => setView({ ...shown, finding: id });

  return (
    <>
      {list.result === "loading" && <p className="muted">Loading Findings…</p>}
      {list.result !== "loading" && <CallRefused result={list.result} onRetry={list.retry} />}
      {list.result !== "loading" && list.result.kind === "no-team" && (
        <p className="notice" role="alert">
          Choose a Team first, from the switcher above.
        </p>
      )}
      {list.result !== "loading" && list.result.kind === "team-not-opened" && (
        <p className="notice" role="alert">
          {TEAM_NOT_OPENED}
        </p>
      )}
      {findings !== null && (
        <>
          <h1 className="summary-line">{summaryLine(findings)}</h1>
          <TopFive findings={topFive(findings)} focused={focused} onSelect={select} />
          {findings.length > 0 && (
            <section className="all-findings" aria-labelledby="all-findings">
              <h2 id="all-findings">All Findings</h2>
              <div className="filters">
                <FilterTabs
                  label="Status"
                  choices={STATUS_CHOICES}
                  chosen={shown.status}
                  onChoose={(status) => choose({ status })}
                />
                <FilterTabs
                  label="Severity"
                  choices={SEVERITY_CHOICES}
                  chosen={shown.severity}
                  onChoose={(severity) => choose({ severity })}
                />
                <FilterTabs
                  label="Module"
                  choices={MODULE_CHOICES}
                  chosen={shown.module}
                  onChoose={(module) => choose({ module })}
                />
                <code className="view-path">{path}</code>
              </div>
              <FindingsTable
                findings={inView(findings, shown)}
                focused={focused}
                onSelect={select}
              />
            </section>
          )}
        </>
      )}
    </>
  );
}

function SeverityPill({ finding }: { finding: Finding }) {
  return (
    <span className={`sev-pill sev-${finding.severity}`}>{SEVERITY_WORDS[finding.severity]}</span>
  );
}

/** Up to five Open Findings as cards, most urgent first. Nothing when none is Open. */
function TopFive(props: {
  findings: Finding[];
  focused: string | undefined;
  onSelect: (id: string) => void;
}) {
  if (props.findings.length === 0) return null;
  return (
    <section className="start-here" aria-labelledby="start-here">
      <h2 id="start-here">Start here</h2>
      <ol className="top-five" aria-labelledby="start-here">
        {props.findings.map((finding, i) => (
          <li key={finding.id}>
            {/* A button: Enter and Space select it as a click does. */}
            <button
              type="button"
              className="finding-card"
              data-finding={finding.id}
              aria-pressed={finding.id === props.focused}
              onClick={() => props.onSelect(finding.id)}
            >
              <span className="card-top">
                <span className="card-rank">{i + 1}</span>
                <SeverityPill finding={finding} />
              </span>
              <span className="card-title">{finding.title}</span>
              <span className="card-summary">{finding.evidence.summary}</span>
              <span className="card-asset">
                <span className="asset-ref">{finding.asset.ref}</span>
                <span className="asset-kind">{ASSET_KIND_WORDS[finding.asset.kind]}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One filter group: a choice per button, the chosen one pressed. */
function FilterTabs<V extends string>(props: {
  label: string;
  choices: Choice<V>[];
  chosen: V;
  onChoose: (value: V) => void;
}) {
  return (
    <div className="filter-tabs" role="group" aria-label={props.label}>
      {props.choices.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className="filter-tab"
          aria-pressed={value === props.chosen}
          onClick={() => props.onChoose(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function FindingsTable(props: {
  findings: Finding[];
  focused: string | undefined;
  onSelect: (id: string) => void;
}) {
  const onKeyDown = (id: string) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelect(id);
    }
  };
  return (
    <table className="findings-table" aria-labelledby="all-findings">
      <thead>
        <tr>
          <th scope="col">Severity</th>
          <th scope="col">Finding</th>
          <th scope="col" className="asset-col">
            Asset
          </th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {props.findings.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              Nothing matches this view.
            </td>
          </tr>
        )}
        {props.findings.map((finding) => (
          <tr
            key={finding.id}
            tabIndex={0}
            aria-selected={finding.id === props.focused}
            onClick={() => props.onSelect(finding.id)}
            onKeyDown={onKeyDown(finding.id)}
          >
            <td>
              <SeverityPill finding={finding} />
            </td>
            <td>
              <span className="finding-title">{finding.title}</span>
              <code className="rule-id">
                {finding.rule_id} · {shortId(finding.id)}
              </code>
            </td>
            <td className="asset-col">
              <span className="asset-ref">{finding.asset.ref}</span>
              <span className="asset-kind">{ASSET_KIND_WORDS[finding.asset.kind]}</span>
            </td>
            <td>
              {STATUS_WORDS[finding.status]}
              {finding.status === "fixed" && finding.unconfirmed_fix !== null && (
                <span className="flag">{UNCONFIRMED_FIX}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
