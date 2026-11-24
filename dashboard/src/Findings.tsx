// The Findings page (story 9, docs/design.md direction E): a one-line summary, the five most urgent Open Findings as
// cards ("Start here"), then every Finding that matches the view in a table, with filter tabs. The view lives in the
// URL: a filter pushes a history entry, so Back and Forward step through views; selecting a Finding replaces the
// entry, so a reload or a shared link selects it again.
import {
  FindingsView,
  findingsViewPath,
  Module,
  Severity,
  type Finding,
  type Level,
} from "@warden/contracts";
import { useCallback, useEffect, useState } from "react";
import { askAboutTeam } from "./api.ts";
import type { PageProps } from "./App.tsx";
import {
  ASSET_KIND_WORDS,
  LEVEL_WORDS,
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
import { findingsViewWords } from "./panel.ts";
import { SeverityPill } from "./SeverityPill.tsx";
import { CallRefused, TeamRefused, useWardenCall } from "./warden-call.tsx";

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

export function FindingsPage({ getToken, me, onSessionEnded, panel }: PageProps) {
  // An answer about a Team the person just switched away from is asked again, then counts as not answering.
  const listFindings = useCallback(
    (signal: AbortSignal) =>
      askAboutTeam(
        () => fetchFindings(getToken),
        (result) => (result.kind === "findings" ? result.team : undefined),
        me.team,
        signal,
      ),
    [getToken, me.team],
  );
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

  /** A filter tab: a new history entry, and the table swaps at once. A tab already chosen changes nothing. */
  function choose(change: Partial<FindingsView>) {
    const next = { ...shown, ...change };
    const nextPath = findingsViewPath(next);
    if (nextPath === path) return;
    history.pushState(null, "", nextPath);
    setView(next);
  }

  // The Ask Warden panel talks about this view and the focused Finding; its detail card's ✕ clears the focus.
  const focusedFinding = findings?.find((f) => f.id === focused) ?? null;
  const clearFocus = useCallback(() => setView((old) => ({ ...old, finding: undefined })), []);
  const { setContext, open: openPanel } = panel;
  const { status, severity, module } = shown;
  useEffect(() => {
    setContext({
      view: findingsViewWords({ status, severity, module }),
      focus: focusedFinding,
      clearFocus,
    });
  }, [setContext, status, severity, module, focusedFinding, clearFocus]);
  // As the page goes (a Team switch, sign-out), its context goes with it.
  useEffect(() => () => setContext(null), [setContext]);

  /** Selecting a Finding replaces the address's entry (the effect above writes it), and opens a closed panel. */
  const select = (id: string) => {
    setView({ ...shown, finding: id });
    openPanel();
  };

  return (
    <>
      {list.result === "loading" && <p className="muted">Loading Findings…</p>}
      {list.result !== "loading" && <CallRefused result={list.result} onRetry={list.retry} />}
      {list.result !== "loading" && <TeamRefused result={list.result} />}
      {findings !== null && (
        <>
          {me.level !== null && <LevelLine level={me.level} />}
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

/** The Team's Level, one quiet line above the summary, linking to the journey on Overview. */
function LevelLine({ level }: { level: Level }) {
  return (
    <p className="level-line">
      Level: {LEVEL_WORDS[level]} · <a href="/overview">see the journey</a>
    </p>
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
            {/* A button: Enter and Space select it as a click does. Selected, it's the page's current Finding. */}
            <button
              type="button"
              className="finding-card"
              data-finding={finding.id}
              aria-current={finding.id === props.focused ? "true" : undefined}
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
          // A click anywhere on the row selects it; the keyboard and screen readers use the button in its title cell.
          <tr
            key={finding.id}
            className={finding.id === props.focused ? "selected" : undefined}
            onClick={() => props.onSelect(finding.id)}
          >
            <td className="narrow">
              <SeverityPill finding={finding} />
            </td>
            <td>
              <button
                type="button"
                className="finding-link"
                aria-current={finding.id === props.focused ? "true" : undefined}
                onClick={() => props.onSelect(finding.id)}
              >
                <span className="finding-title">{finding.title}</span>
                <code className="rule-id">
                  {finding.rule_id} · {shortId(finding.id)}
                </code>
              </button>
            </td>
            <td className="asset-col">
              <span className="asset-ref">{finding.asset.ref}</span>
              <span className="asset-kind">{ASSET_KIND_WORDS[finding.asset.kind]}</span>
            </td>
            <td className="narrow">
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
