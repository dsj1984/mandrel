/**
 * audit-to-stories.js — turn audit-* report findings into a dedup-checked
 * plan, a `/mandrel-plan` seed, or standalone Story drafts. Throws rather than
 * calling Logger.fatal so runAsCli owns the exit code.
 */

import fs from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildStoryBody } from './lib/audit-to-stories/build-story-body.js';
import { classifyGroupsAgainstGitHub } from './lib/audit-to-stories/dedupe-against-github.js';
import { formatEpicGrouping } from './lib/audit-to-stories/epic-grouping-directive.js';
import {
  toCanonicalFinding,
  withFingerprints,
} from './lib/audit-to-stories/finding-adapter.js';
import { groupFindings } from './lib/audit-to-stories/group-findings.js';
import {
  loadIssuesFile,
  normaliseIssueHit,
} from './lib/audit-to-stories/issues-file.js';
import {
  resolveLedgerSummary,
  runLedgerCommit,
} from './lib/audit-to-stories/ledger-commit.js';
import { recordFiledIssues } from './lib/audit-to-stories/ledger-record.js';
import {
  parseAuditReports,
  readSeverityTally,
} from './lib/audit-to-stories/parse-audit-md.js';
import { buildPlanSeedMarkdown } from './lib/audit-to-stories/seed-from-findings.js';
import { wireAuditStoryEdges } from './lib/audit-to-stories/wire-dependencies.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  DEFAULT_LEDGER_PATH,
  readLedger,
  reconcileLedger,
  writeLedger,
} from './lib/findings/audit-ledger.js';
import { searchSemanticCandidates } from './lib/findings/semantic-issue-search.js';
import {
  normalizeSeverity,
  SEVERITIES,
  SEVERITY_RANK,
} from './lib/findings/severity.js';
import { Logger } from './lib/Logger.js';
import { parse as parseStoryBody } from './lib/story-body/story-body.js';

const DEFAULT_GLOB = 'temp/audits/audit-*-results.md';
const FAN_OUT_REPORT = 'audit-fan-out-results.md';

/**
 * Does `finding` clear the `threshold` floor? An unparsed severity ranks below
 * every real floor.
 *
 * @param {{ severity?: string }} finding
 * @param {string} [threshold] — a canonical level, `'all'`, or falsy for no floor.
 * @returns {boolean}
 */
function meetsSeverity(finding, threshold) {
  if (!threshold || threshold === 'all') return true;
  const minRank = SEVERITY_RANK[threshold] ?? 0;
  const fRank = SEVERITY_RANK[finding.severity] ?? -1;
  return fRank >= minRank;
}

async function collectReportPaths(pattern) {
  const matches = [];
  for await (const entry of glob(pattern)) {
    if (path.basename(entry) === FAN_OUT_REPORT) continue;
    matches.push(entry);
  }
  return matches.sort();
}

function readReports(paths) {
  return paths.map((p) => ({
    sourceReport: p,
    markdown: fs.readFileSync(p, 'utf8'),
  }));
}

/**
 * Count findings per canonical level, plus a visible `unknown` bucket for an
 * unparsed severity.
 *
 * @param {Array<{ severity?: string }>} findings
 * @returns {Record<string, number>}
 */
function tallyBySeverity(findings) {
  const t = {
    ...Object.fromEntries(SEVERITIES.map((s) => [s, 0])),
    unknown: 0,
  };
  for (const f of findings) {
    if (Object.hasOwn(t, f.severity)) t[f.severity] += 1;
    else t.unknown += 1;
  }
  return t;
}

/** The levels a `Severity tally:` line declares; `info` and `unknown` are not comparable. */
const TALLY_LEVELS = Object.freeze(['critical', 'high', 'medium', 'low']);

/**
 * @param {Array<{ severity?: string }>} findings
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
function comparableTally(findings) {
  const full = tallyBySeverity(findings);
  return Object.fromEntries(TALLY_LEVELS.map((level) => [level, full[level]]));
}

function sameTally(a, b) {
  return TALLY_LEVELS.every((level) => a[level] === b[level]);
}

function formatTally(tally) {
  if (!tally) return '(no Severity tally line)';
  return `Critical ${tally.critical} / High ${tally.high} / Medium ${tally.medium} / Low ${tally.low}`;
}

/**
 * Cross-check the reports, warn on stderr, and throw under
 * `failOnReportFailures` (`--auto`) BEFORE any ledger or GitHub write; `--scan`
 * carries the failures on the plan envelope instead.
 *
 * @param {object} params
 * @param {Array<{ sourceReport: string, markdown: string }>} params.reports
 * @param {Array<object>} params.findings — every parsed finding, unfiltered.
 * @param {boolean} [params.allowMissingTally]
 * @param {boolean} [params.failOnReportFailures]
 * @param {{ warn: Function }} params.logger
 * @returns {Array<object>} the failures, for `summary.reportFailures[]`.
 */
function auditReportFailures({
  reports,
  findings,
  allowMissingTally,
  failOnReportFailures,
  logger,
}) {
  const { failures, warnings } = crossCheckReports({
    reports,
    findings,
    allowMissingTally,
  });
  for (const warning of warnings) logger.warn(warning);
  if (failures.length === 0) return failures;
  const message = reportFailureWarning(failures);
  logger.warn(message);
  if (failOnReportFailures) {
    throw new Error(
      `refusing to file from an unverified report set. ${message}`,
    );
  }
  return failures;
}

/**
 * Cross-check each report's declared `Severity tally:` line against what the
 * parser extracted — a parser that silently drops findings otherwise looks
 * like a clean report. Failure kinds: `missing-tally` (the only kind
 * `allowMissingTally` downgrades to a warning), `tally-mismatch`,
 * `duplicate-tally` (no single number to check; contradictory, never
 * downgraded), and `unresolved-severity`. Pure; the caller owns stderr.
 *
 * @param {object} params
 * @param {Array<{ sourceReport: string, markdown: string }>} params.reports
 * @param {Array<{ sourceReport: string, severity?: string, title?: string }>} params.findings
 * @param {boolean} [params.allowMissingTally]
 * @returns {{ failures: Array<object>, warnings: string[] }}
 */
function crossCheckReports({ reports, findings, allowMissingTally }) {
  const failures = [];
  const warnings = [];
  const byReport = new Map(reports.map((r) => [r.sourceReport, []]));
  for (const finding of findings) {
    byReport.get(finding.sourceReport)?.push(finding);
  }

  for (const report of reports) {
    const own = byReport.get(report.sourceReport) ?? [];
    const parsed = comparableTally(own);
    const {
      tally: reported,
      matches: tallyLines,
      duplicate,
    } = readSeverityTally(report.markdown);
    const sourceReport = report.sourceReport;
    const unresolved = own.filter((f) => !f.severity);
    if (unresolved.length > 0) {
      failures.push({
        sourceReport,
        kind: 'unresolved-severity',
        reported,
        parsed,
        titles: unresolved.map((f) => f.title),
      });
    }
    if (duplicate) {
      failures.push({
        sourceReport,
        kind: 'duplicate-tally',
        reported: null,
        parsed,
        tallyLines,
      });
      continue;
    }
    if (!reported) {
      const failure = {
        sourceReport,
        kind: 'missing-tally',
        reported: null,
        parsed,
      };
      if (allowMissingTally) warnings.push(missingTallyWarning(failure));
      else failures.push(failure);
      continue;
    }
    if (!sameTally(reported, parsed)) {
      failures.push({ sourceReport, kind: 'tally-mismatch', reported, parsed });
    }
  }

  return { failures, warnings };
}

/**
 * @param {{ sourceReport: string, parsed: object }} failure
 * @returns {string}
 */
function missingTallyWarning(failure) {
  return `audit report cross-check: ${failure.sourceReport} declares no "Severity tally:" line — downgraded to a warning by --allow-missing-tally (parsed ${formatTally(failure.parsed)}). --auto ignores that flag and refuses the report.`;
}

/**
 * One line per failure naming the report and BOTH tallies, so the operator
 * sees which side is wrong.
 *
 * @param {Array<{ sourceReport: string, kind: string, reported: object|null, parsed: object, titles?: string[], tallyLines?: string[] }>} failures
 * @returns {string}
 */
function reportFailureWarning(failures) {
  const lines = failures.map((f) => {
    const titles = f.titles?.length
      ? ` findings=${f.titles.map((t) => `"${t}"`).join(', ')}`
      : '';
    // A duplicate has no single `reported` number; name the competing lines.
    const declared = f.tallyLines?.length
      ? ` declared=${f.tallyLines.map((t) => `"${t}"`).join(' | ')}`
      : '';
    return `  - ${f.sourceReport} [${f.kind}] reported=${formatTally(f.reported)} parsed=${formatTally(f.parsed)}${titles}${declared}`;
  });
  return [
    `audit report cross-check FAILED for ${failures.length} report(s) — the declared severity tally does not match the parsed findings:`,
    ...lines,
    'Every report must carry "Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>" in its Executive Summary, matching its own findings. Fix the report (or re-run the lens) before filing.',
  ].join('\n');
}

/**
 * Test-only seam: `AUDIT_TO_STORIES_PROVIDER_FIXTURE` names a module whose
 * default export replaces the whole provider adapter, so the real CLI runs
 * with no network.
 *
 * @returns {Promise<object|null>}
 */
async function loadFixtureProvider() {
  const fixturePath = process.env.AUDIT_TO_STORIES_PROVIDER_FIXTURE;
  if (!fixturePath) return null;
  const mod = await import(pathToFileURL(fixturePath).href);
  return mod.default ?? null;
}

/**
 * Why the live provider could not be adapted. A typed reason lets
 * `--wire-edges`, which cannot degrade, name the missing precondition.
 */
class ProviderUnavailableError extends Error {
  /**
   * @param {'no-config'|'provider-construction-failed'|'no-search-port'} reason
   * @param {string} detail
   */
  constructor(reason, detail) {
    super(detail);
    this.name = 'ProviderUnavailableError';
    this.reason = reason;
  }
}

/**
 * List issues once per label (the REST `labels` filter is an AND, we need an
 * OR) and merge them deduplicated. The list endpoint has a far larger
 * rate-limit budget than search.
 *
 * @param {object} provider
 * @param {string[]} labels
 * @returns {Promise<Array<object>>}
 */
async function listIssuesForLabels(provider, labels) {
  const seen = new Map();
  for (const label of labels) {
    const issues = await provider.listIssuesByLabel({
      state: 'all',
      labels: label,
    });
    for (const raw of issues ?? []) {
      const hit = normaliseIssueHit(raw);
      if (!seen.has(hit.number)) seen.set(hit.number, hit);
    }
  }
  return [...seen.values()];
}

/**
 * The dedupe module's read ports, adapted here so it holds no provider-shape
 * knowledge.
 *
 * @param {object} provider
 * @param {{ owner: string, repo: string }} coords
 * @returns {{ findIssuesByFingerprint: Function, listAuditIssues: Function,
 *   searchCandidates: Function }}
 */
function buildDedupPorts(provider, { owner, repo }) {
  return {
    async findIssuesByFingerprint(sha) {
      const hits = await provider.searchIssues({ query: sha, owner, repo });
      return (hits ?? []).map(normaliseIssueHit);
    },
    /**
     * Every Issue carrying one of the run's `audit::*` labels, for the
     * fingerprint index. `null` (no list port) falls back to per-finding search.
     *
     * @param {string[]} labels
     * @returns {Promise<Array<object>|null>}
     */
    async listAuditIssues(labels) {
      if (typeof provider.listIssuesByLabel !== 'function') return null;
      return listIssuesForLabels(provider, labels);
    },
    async searchCandidates(finding) {
      const search = async (query) => {
        if (!query || query.trim().length === 0) return [];
        const hits = await provider.searchIssues({ query, owner, repo });
        return (hits ?? []).map(normaliseIssueHit);
      };
      return searchSemanticCandidates(finding, { search });
    },
  };
}

/**
 * The provider's write ports, **bound** — `GitHubProvider` delegates off
 * `this`, so an unbound reference throws. A missing port is omitted, not
 * stubbed, so the wire step's per-port degradation still sees it.
 *
 * @param {object} provider
 * @returns {Record<string, Function>}
 */
function bindWritePorts(provider) {
  const ports = {};
  for (const name of PROVIDER_WRITE_PORTS) {
    if (typeof provider[name] === 'function') {
      ports[name] = provider[name].bind(provider);
    }
  }
  return ports;
}

/** The provider ports `--wire-edges` needs on the far side of the adapter. */
const PROVIDER_WRITE_PORTS = [
  'updateTicket',
  'getTicket',
  'getDependencyWriteContext',
];

/**
 * @param {{ createProviderImpl?: Function, resolveConfigImpl?: Function }} seams
 * @returns {Promise<{ config: object, provider: object }>}
 * @throws {ProviderUnavailableError}
 */
async function constructProvider({ createProviderImpl, resolveConfigImpl }) {
  let config;
  try {
    const resolveConfig =
      resolveConfigImpl ??
      (await import('./lib/config-resolver.js')).resolveConfig;
    config = resolveConfig();
  } catch (err) {
    throw new ProviderUnavailableError(
      'no-config',
      `resolving the project config failed: ${err.message}`,
    );
  }
  if (!config?.github?.owner || !config?.github?.repo) {
    throw new ProviderUnavailableError(
      'no-config',
      'github.owner and github.repo must both be set in .agentrc.json',
    );
  }
  try {
    const createProvider =
      createProviderImpl ??
      (await import('./lib/provider-factory.js')).createProvider;
    return { config, provider: createProvider(config) };
  } catch (err) {
    throw new ProviderUnavailableError(
      'provider-construction-failed',
      `constructing the configured provider failed: ${err.message}`,
    );
  }
}

/**
 * Adapt the configured provider: dedup read ports plus bound write ports.
 *
 * @param {{ createProviderImpl?: Function, resolveConfigImpl?: Function }} [seams]
 * @returns {Promise<object>} the adapter (never null).
 * @throws {ProviderUnavailableError} when no live provider could be adapted.
 */
async function loadProvider({ createProviderImpl, resolveConfigImpl } = {}) {
  const fixture = await loadFixtureProvider();
  if (fixture) return fixture;
  const { config, provider } = await constructProvider({
    createProviderImpl,
    resolveConfigImpl,
  });
  if (typeof provider.searchIssues !== 'function') {
    throw new ProviderUnavailableError(
      'no-search-port',
      'the configured provider exposes no searchIssues port',
    );
  }
  return {
    ...buildDedupPorts(provider, {
      owner: config.github.owner,
      repo: config.github.repo,
    }),
    ...bindWritePorts(provider),
  };
}

/**
 * Soft-fail `loadProvider` for dedup, which degrades to create-only and warns.
 *
 * @param {{ createProviderImpl?: Function, resolveConfigImpl?: Function }} [seams]
 * @returns {Promise<object|null>}
 */
async function loadProviderOrNull(seams = {}) {
  try {
    return await loadProvider(seams);
  } catch (_) {
    return null;
  }
}

/**
 * Warning for a dedup that did not run: `no-provider-port` (no usable provider
 * — otherwise a silent all-`create` plan) or `disabled` (`--no-provider`).
 *
 * @param {'no-provider-port'|'disabled'} reason
 * @returns {string}
 */
function dedupSkippedWarning(reason) {
  if (reason === 'disabled') {
    return (
      'dedup skipped (--no-provider): every group is classified "create" ' +
      'without checking GitHub for existing issues. A re-run may open ' +
      'duplicates of already-tracked or already-closed findings. Drop ' +
      '--no-provider to enable fingerprint dedup against real issues.'
    );
  }
  return (
    'dedup skipped (no provider port): the configured provider exposes no ' +
    'searchIssues() port, so Phase 6 dedup did NOT run. Every group is ' +
    'classified "create" and existing/closed issues are NOT checked — a run ' +
    'that creates Stories from this plan WILL open duplicates of ' +
    'already-tracked work. Verify `gh auth status` and the github.{owner,repo} ' +
    'config so a real provider resolves.'
  );
}

/**
 * Warning naming each group whose lookup could not complete (422, exhausted
 * rate limit) and so degraded to `create` unchecked.
 *
 * @param {Array<{ group: string, reason: string }>} entries
 * @returns {string}
 */
function dedupDegradedWarning(entries) {
  const lines = (entries ?? []).map((e) => `  - ${e.group}: ${e.reason}`);
  return (
    `dedup degraded for ${lines.length} group(s): their GitHub lookup could ` +
    'not complete, so they are classified "create" WITHOUT a dedup check. A ' +
    'run that creates Stories from this plan may open duplicates of these ' +
    `groups — verify each by hand before opening:\n${lines.join('\n')}`
  );
}

/**
 * Always emitted for `--issues-file`: the corpus size separates a real dedup
 * from one that merely looks checked. Zero is ambiguous (first sweep or broken
 * fetch), so the operator decides.
 *
 * @param {{ source?: string, size?: number }} dedupIndex
 * @returns {string}
 */
function dedupIndexWarning({ size = 0 } = {}) {
  if (size === 0) {
    return (
      'dedup index: 0 issues supplied via --issues-file. Dedup DID run and ' +
      'every group is correctly "create" — but that is also what a fetch that ' +
      'returned nothing looks like. If audit issues already exist, the fetch ' +
      'that wrote this file is broken and this run will re-file them.'
    );
  }
  return `dedup index: ${size} issue(s) supplied via --issues-file; every exact-fingerprint lookup was answered from it.`;
}

/**
 * Warning for a failed index pre-fetch; dedup falls back to per-finding search.
 *
 * @param {string} reason
 * @returns {string}
 */
function dedupIndexDegradedWarning(reason) {
  return (
    `dedup index unavailable: ${reason}. Dedup fell back to a per-finding ` +
    'search, which is slower and rate-limited — if those searches also fail, ' +
    'every affected group is classified "create" WITHOUT a dedup check.'
  );
}

/**
 * Classify every group against GitHub and warn on stderr whichever way it
 * went. A host-supplied corpus is a dedup source on its own, so
 * `--no-provider --issues-file` (the `gh`-less host) still dedups; only with
 * neither a provider nor a corpus is every group `create`.
 *
 * @param {{ groups: Array<object>, useProvider?: boolean,
 *   issues?: Array<object>|null }} params
 * @param {{ loadProviderImpl: Function, classifyGroupsImpl: Function,
 *   logger: { warn: Function } }} deps
 * @returns {Promise<{ classifications: Array<object>, summary: object,
 *   dedupApplied: boolean }>}
 */
async function runDedupPhase(
  { groups, useProvider, issues },
  { loadProviderImpl, classifyGroupsImpl, logger },
) {
  const provider = useProvider ? await loadProviderImpl() : null;
  if (!provider && !issues) {
    logger.warn(
      dedupSkippedWarning(useProvider ? 'no-provider-port' : 'disabled'),
    );
    return {
      classifications: groups.map((group) => ({
        group,
        action: 'create',
        matchedIssues: [],
        matchedFingerprints: [],
      })),
      summary: { create: groups.length, skipOpen: 0, skipReoccurring: 0 },
      dedupApplied: false,
    };
  }

  const { classifications, summary } = await classifyGroupsImpl({
    groups,
    provider,
    searchCandidates: provider?.searchCandidates,
    listAuditIssues: provider?.listAuditIssues,
    issues,
  });
  for (const warning of dedupPhaseWarnings({ issues, summary })) {
    logger.warn(warning);
  }
  return { classifications, summary, dedupApplied: true };
}

/**
 * @param {{ issues?: Array<object>|null, summary: object }} params
 * @returns {string[]}
 */
function dedupPhaseWarnings({ issues, summary }) {
  const warnings = [];
  if (issues) warnings.push(dedupIndexWarning(summary.dedupIndex));
  if (summary.dedupDegraded?.indexPrefetch) {
    warnings.push(
      dedupIndexDegradedWarning(summary.dedupDegraded.indexPrefetch),
    );
  }
  if (summary.dedupDegraded?.count > 0) {
    warnings.push(dedupDegradedWarning(summary.dedupDegraded.groups));
  }
  return warnings;
}

/**
 * Scan → group → dedup → (optionally) reconcile the cross-run ledger.
 *
 * @param {{ glob?: string, severity?: string, useProvider?: boolean,
 *   issuesFile?: string, ledger?: object }} params
 * @param {{
 *   collectReportPathsImpl?: typeof collectReportPaths,
 *   readReportsImpl?: typeof readReports,
 *   loadProviderImpl?: typeof loadProviderOrNull,
 *   classifyGroupsImpl?: typeof classifyGroupsAgainstGitHub,
 *   loadIssuesFileImpl?: typeof loadIssuesFile,
 *   reconcileScanLedgerImpl?: typeof reconcileScanLedger,
 *   logger?: { warn: Function },
 * }} [deps]
 * @returns {Promise<object>} the plan envelope.
 */
async function buildPlan(
  {
    glob: pattern,
    severity,
    useProvider,
    issuesFile,
    ledger,
    allowMissingTally,
    failOnReportFailures,
  },
  deps = {},
) {
  const {
    collectReportPathsImpl = collectReportPaths,
    readReportsImpl = readReports,
    loadProviderImpl = loadProviderOrNull,
    classifyGroupsImpl = classifyGroupsAgainstGitHub,
    loadIssuesFileImpl = loadIssuesFile,
    reconcileScanLedgerImpl = reconcileScanLedger,
    logger = Logger,
  } = deps;
  // Before reading reports: an unusable corpus is a usage error, not a fallback.
  const issues = issuesFile ? loadIssuesFileImpl(issuesFile) : null;
  const reportPaths = await collectReportPathsImpl(pattern ?? DEFAULT_GLOB);
  if (reportPaths.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      sourceReports: [],
      severityThreshold: severity ?? 'all',
      findings: [],
      groups: [],
      edges: [],
      classifications: [],
      summary: {
        totalFindings: 0,
        filtered: 0,
        create: 0,
        skipOpen: 0,
        skipReoccurring: 0,
        reportFailures: [],
      },
    };
  }

  const reports = readReportsImpl(reportPaths);
  const allFindings = parseAuditReports(reports, { repoRoot: process.cwd() });
  const reportFailures = auditReportFailures({
    reports,
    findings: allFindings,
    allowMissingTally,
    failOnReportFailures,
    logger,
  });
  const filtered = allFindings.filter((f) => meetsSeverity(f, severity));
  // An unresolved severity is a report defect (tallied, never grouped).
  const stamped = withFingerprints(filtered.filter((f) => Boolean(f.severity)));
  const { groups, edges } = groupFindings(stamped);

  const { classifications, summary, dedupApplied } = await runDedupPhase(
    { groups, useProvider, issues },
    { loadProviderImpl, classifyGroupsImpl, logger },
  );

  // Opt-in: plain --scan never mutates the committed ledger.
  let ledgerSummary;
  if (ledger) {
    const suppressed = reconcileScanLedgerImpl({
      ledgerPath: ledger.path ?? DEFAULT_LEDGER_PATH,
      findings: stamped,
      classifications,
      write: ledger.write !== false,
    });
    if (suppressed.size > 0) {
      for (const c of classifications) {
        const findings = c.group?.findings ?? [];
        if (
          findings.length > 0 &&
          findings.every((f) => suppressed.has(f?.fingerprint?.full))
        ) {
          c.action = 'skip-accepted-risk';
        }
      }
    }
    ledgerSummary = {
      path: ledger.path ?? DEFAULT_LEDGER_PATH,
      suppressed: suppressed.size,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceReports: reportPaths,
    severityThreshold: severity ?? 'all',
    findings: stamped,
    groups,
    edges,
    classifications,
    summary: {
      totalFindings: allFindings.length,
      filtered: filtered.length,
      tally: tallyBySeverity(filtered),
      reportFailures,
      dedupApplied,
      ...(ledgerSummary ? { ledger: ledgerSummary } : {}),
      ...summary,
    },
  };
}

/**
 * Fold the scan onto the ledger, persist it, and return the accepted-risk
 * fingerprints to suppress.
 *
 * @param {object} params
 * @param {string} params.ledgerPath
 * @param {Array<object>} params.findings — stamped scan findings.
 * @param {Array<{ group?: object, matchedIssues?: Array<{ number: number, state: string }>, matchedFingerprints?: string[] }>} params.classifications
 * @param {boolean} [params.write=true]
 * @returns {Set<string>}
 */
function reconcileScanLedger({ ledgerPath, findings, classifications, write }) {
  const prior = readLedger(ledgerPath);
  const issueStates = issueStatesFromClassifications(classifications);
  const { ledger: next } = reconcileLedger({
    ledger: prior,
    findings,
    issueStates,
    // Passed in: the ledger importing the audit adapter would close a cycle.
    toCanonical: toCanonicalFinding,
  });
  if (write !== false) writeLedger(ledgerPath, next);
  return new Set(
    next.entries
      .filter((e) => e.status === 'accepted-risk')
      .map((e) => e.fingerprint),
  );
}

/**
 * @param {Array<object>} classifications
 * @returns {Record<string, { state: string, number: number|null }>}
 */
function issueStatesFromClassifications(classifications) {
  const states = {};
  for (const c of classifications ?? []) {
    const issue = (c.matchedIssues ?? [])[0];
    if (!issue) continue;
    const state = String(issue.state ?? '')
      .toLowerCase()
      .includes('closed')
      ? 'closed'
      : 'open';
    for (const fp of c.matchedFingerprints ?? []) {
      states[fp] = { state, number: issue.number ?? null };
    }
  }
  return states;
}

function loadPlan(planPath) {
  if (!planPath) throw new Error('--plan <path> is required');
  return JSON.parse(fs.readFileSync(planPath, 'utf8'));
}

/** The `--auto` severity floor when `--severity` names none. */
const DEFAULT_SEVERITY_FLOOR = 'high';

/**
 * @param {string|undefined} explicit
 * @returns {string}
 */
function severityFloorOf(explicit) {
  return explicit || DEFAULT_SEVERITY_FLOOR;
}

/**
 * Unattended `--auto` sweep: build the plan with ledger reconciliation and
 * return a summary plus the create-eligible Story payloads (none under
 * `--dry-run`, which writes nothing). Never prompts.
 *
 * @param {object} params
 * @param {string} [params.glob]
 * @param {string} [params.severity] — explicit floor override.
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.useProvider]
 * @param {string} [params.ledgerPath]
 * @param {boolean} [params.ledgerCommit] — the operator asked for a ledger PR,
 *   so an unpersistable checkout is not a warning: it is about to be fixed.
 * @param {(cwd: string, ...args: string[]) => string} [params.git] — probe seam.
 * @param {string} [params.cwd]
 * @param {{ warn: Function }} [params.logger]
 * @returns {Promise<{ summary: object, stories: Array<object> }>}
 */
async function runAuto({
  glob,
  severity,
  dryRun,
  useProvider,
  issuesFile,
  ledgerPath,
  ledgerCommit,
  git,
  cwd,
  logger = Logger,
}) {
  const floor = severityFloorOf(severity);
  const resolvedLedgerPath = ledgerPath ?? DEFAULT_LEDGER_PATH;
  const plan = await buildPlan({
    glob,
    severity: floor,
    useProvider,
    issuesFile,
    ledger: { path: resolvedLedgerPath, write: !dryRun },
    // No operator reads warnings unattended, so every report failure is fatal.
    allowMissingTally: false,
    failOnReportFailures: true,
  });

  const byAction = {
    create: [],
    skipOpen: [],
    skipReoccurring: [],
    suppressed: [],
  };
  for (const c of plan.classifications ?? []) {
    if (c.action === 'create') byAction.create.push(c);
    else if (c.action === 'skip-open') byAction.skipOpen.push(c);
    else if (c.action === 'skip-reoccurring') byAction.skipReoccurring.push(c);
    else if (c.action === 'skip-accepted-risk') byAction.suppressed.push(c);
  }

  const eligible = byAction.create.map((c) => c.group);
  const stories = dryRun ? [] : buildAndGateStories(eligible, plan.edges ?? []);

  const summary = {
    mode: 'auto',
    dryRun: Boolean(dryRun),
    severityFloor: floor,
    sourceReports: plan.sourceReports ?? [],
    totals: {
      findings: plan.summary?.totalFindings ?? 0,
      filtered: plan.summary?.filtered ?? 0,
      groups: (plan.groups ?? []).length,
      create: byAction.create.length,
      skipOpen: byAction.skipOpen.length,
      skipReoccurring: byAction.skipReoccurring.length,
      suppressedByLedger: byAction.suppressed.length,
    },
    // The caller opens the Issues; these keys feed its `--wire-edges --ids`
    // map, without which the ledger never records what was filed.
    createGroupKeys: eligible.map((g) => g?.groupKey).filter(Boolean),
    reDetected: byAction.skipOpen
      .flatMap((c) => c.matchedIssues ?? [])
      .map((i) => i.number)
      .filter((n) => typeof n === 'number'),
    // An ephemeral clone may not be able to keep the ledger it just wrote.
    ledger: await resolveLedgerSummary({
      ledger: plan.summary?.ledger ?? null,
      ledgerPath: resolvedLedgerPath,
      dryRun,
      ledgerCommit,
      cwd,
      git,
      logger,
    }),
  };

  return { summary, stories };
}

/**
 * Build each eligible group into a Story and throw BEFORE any issue is opened
 * unless every body re-parses with non-empty `acceptance[]` and `verify[]` —
 * this path skips the decomposer's inline-contract assertion.
 *
 * @param {Array<{ group: object }>} eligible — classifications eligible to create.
 * @param {Array<{ fromGroupKey: string, toGroupKey: string }>} edges — sequencing edges.
 * @returns {Array<{ title: string, body: string, labels: string[] }>}
 */
function buildAndGateStories(eligible, edges) {
  const built = eligible.map((g) => buildStoryBody({ group: g, edges }));
  const offenders = [];
  for (const story of built) {
    const { body } = parseStoryBody(story.body);
    const ok =
      Array.isArray(body.acceptance) &&
      body.acceptance.length > 0 &&
      Array.isArray(body.verify) &&
      body.verify.length > 0;
    if (!ok) offenders.push(story.title);
  }
  if (offenders.length > 0) {
    throw new Error(
      `inline-contract gate failed: ${offenders.length} generated audit Story/Stories lack a non-empty acceptance[] + verify[] contract: ${offenders
        .map((t) => `"${t}"`)
        .join(
          ', ',
        )}. No issues were opened. Every emitted Story must carry both arrays.`,
    );
  }
  return built;
}

/**
 * The unmet precondition, keyed by `loadProvider`'s refusal reason.
 * `--wire-edges` cannot degrade, so its error must name which one.
 */
const WIRE_EDGES_PRECONDITIONS = {
  'no-config': 'github.owner and github.repo are not both set in .agentrc.json',
  'provider-construction-failed':
    'the configured provider could not be constructed — check GH_TOKEN / gh auth',
  'no-search-port': 'the configured provider exposes no issue ports',
  'fixture-no-write-port':
    'AUDIT_TO_STORIES_PROVIDER_FIXTURE names a fixture provider with no updateTicket port',
};

/**
 * @param {string} reason  A `ProviderUnavailableError.reason`, `'fixture-no-write-port'`,
 *   or `'unknown'` for a refusal that carried no reason at all.
 * @param {string} [detail]
 * @returns {Error}
 */
function wireEdgesPreconditionError(reason, detail) {
  const named =
    WIRE_EDGES_PRECONDITIONS[reason] ??
    `the provider could not be loaded (${reason})`;
  return new Error(
    '--wire-edges needs a provider exposing updateTicket to rewrite the ' +
      `Story bodies with their \`blocked by #N\` footers, but ${named}.` +
      (detail ? ` [${detail}]` : ''),
  );
}

/**
 * Second pass after `--emit-stories`: given the opened `groupKey →
 * issueNumber` map, re-render each Story with `blocked by #N` footers, mirror
 * them as native `blocked_by`, and record the filed issues in the ledger.
 *
 * @param {object} params
 * @param {object} params.plan   A `--scan` plan envelope.
 * @param {Record<string, number>} params.issueByGroupKey
 * @param {string} [params.ledgerPath] — ledger to record into; defaults to
 *   `DEFAULT_LEDGER_PATH` inside the record.
 * @param {boolean} [params.write] — `false` computes the record without
 *   persisting it (what `--dry-run` passes).
 * @param {object} [deps]
 * @param {Function} [deps.loadProviderImpl]
 * @param {Function} [deps.wireImpl]
 * @param {Function} [deps.recordFiledIssuesImpl]
 * @returns {Promise<object>} the wiring summary, with the ledger record on
 *   `ledger`.
 */
async function wireEdges(
  { plan, issueByGroupKey, ledgerPath, write },
  deps = {},
) {
  const {
    loadProviderImpl = loadProvider,
    wireImpl = wireAuditStoryEdges,
    recordFiledIssuesImpl = recordFiledIssues,
  } = deps;
  const groups = (plan.classifications ?? [])
    .filter((c) => c.action === 'create')
    .map((c) => c.group);

  // Record before loading the provider: a `gh`-less host, whose only duplicate
  // protection is the ledger, must still remember what it filed.
  const ledger = recordFiledIssuesImpl({
    ledgerPath,
    groups,
    issueByGroupKey,
    write,
  });

  let provider;
  try {
    provider = await loadProviderImpl();
  } catch (err) {
    throw wireEdgesPreconditionError(err.reason ?? 'unknown', err.message);
  }
  if (typeof provider?.updateTicket !== 'function') {
    throw wireEdgesPreconditionError('fixture-no-write-port');
  }
  const wired = await wireImpl({
    groups,
    edges: plan.edges ?? [],
    issueByGroupKey,
    provider,
    updateBody: (issueNumber, body) =>
      provider.updateTicket(issueNumber, { body }),
  });
  return { ...wired, ledger };
}

/**
 * `--ids`: inline JSON `{ groupKey: issueNumber }` or a path to one.
 *
 * @param {string|undefined} raw
 * @returns {Record<string, number>}
 */
function parseIssueMap(raw) {
  if (!raw) {
    throw new Error(
      '--wire-edges requires --ids \'{"<groupKey>": <issueNumber>, ...}\' ' +
        '(or a path to a JSON file with that shape) — the issue numbers the ' +
        'create pass opened. Without them there is nothing to resolve the ' +
        'group edges against.',
    );
  }
  const text = raw.trimStart().startsWith('{')
    ? raw
    : fs.readFileSync(raw, 'utf8');
  const parsed = JSON.parse(text);
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `--ids: "${key}" maps to ${JSON.stringify(value)}, which is not a positive issue number.`,
      );
    }
    out[key] = n;
  }
  return out;
}

function persist(text, outPath) {
  if (!outPath) {
    process.stdout.write(text);
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
}

export const __testing = {
  meetsSeverity,
  collectReportPaths,
  buildPlan,
  crossCheckReports,
  reportFailureWarning,
  loadProvider,
  loadProviderOrNull,
  dedupSkippedWarning,
  dedupDegradedWarning,
  dedupIndexWarning,
  dedupIndexDegradedWarning,
  buildAndGateStories,
  runAuto,
  reconcileScanLedger,
  issueStatesFromClassifications,
  wireEdges,
  parseIssueMap,
};

/**
 * The CLI core: dispatch one sub-command and persist its output.
 *
 * @param {string[]} [argv]
 * @param {{
 *   buildPlanImpl?: typeof buildPlan,
 *   runAutoImpl?: typeof runAuto,
 *   loadPlanImpl?: typeof loadPlan,
 *   buildAndGateStoriesImpl?: typeof buildAndGateStories,
 *   buildPlanSeedMarkdownImpl?: typeof buildPlanSeedMarkdown,
 *   persistImpl?: typeof persist,
 *   stdout?: { write: (s: string) => void },
 * }} [deps]
 * @returns {Promise<void>}
 */
/**
 * The one-line `--ledger-commit` outcome: branch and PR, or the skip reason.
 *
 * @param {{ committed?: boolean, reason?: string, branch?: string,
 *   prUrl?: string|null, resumed?: boolean, ledgerPath?: string }} [result]
 * @returns {string}
 */
function describeLedgerCommit(result) {
  return result?.committed
    ? ledgerCommittedLine(result)
    : ledgerSkippedLine(result);
}

/**
 * @param {object} result
 * @returns {string}
 */
function ledgerCommittedLine(result) {
  const resumed = result.resumed ? ' (resumed an unpushed ledger branch)' : '';
  const pr = result.prUrl ?? '(no URL reported by gh)';
  return `--ledger-commit: pushed ${result.branch}${resumed} and opened ${pr}.`;
}

/**
 * Names the ledger file: its state is still only in the working tree.
 * @param {object} [result]
 * @returns {string}
 */
function ledgerSkippedLine(result) {
  const reason = result?.reason ?? 'no result';
  const ledgerPath = result?.ledgerPath ?? 'the ledger';
  return `--ledger-commit: skipped (${reason}) — ${ledgerPath} was not committed.`;
}

/**
 * Reject an unknown `--severity`: `meetsSeverity` would read a typo as rank 0
 * and silently widen the run to every finding. Absent stays absent.
 *
 * @param {string|undefined} raw
 * @returns {string|undefined} the canonical level.
 */
function validateSeverityFlag(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (String(raw).toLowerCase() === 'all') return 'all';
  const level = normalizeSeverity(String(raw), null);
  if (!level) {
    throw new Error(
      `[audit-to-stories] --severity "${raw}" is not a severity. Accepted: ${SEVERITIES.join(', ')} (or "all").`,
    );
  }
  return level;
}

export async function runAuditToStories(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    buildPlanImpl = buildPlan,
    runAutoImpl = runAuto,
    loadPlanImpl = loadPlan,
    buildAndGateStoriesImpl = buildAndGateStories,
    buildPlanSeedMarkdownImpl = buildPlanSeedMarkdown,
    wireEdgesImpl = wireEdges,
    parseIssueMapImpl = parseIssueMap,
    persistImpl = persist,
    runLedgerCommitImpl = runLedgerCommit,
    stdout = process.stdout,
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: {
      scan: { type: 'boolean' },
      auto: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'emit-plan-seed': { type: 'boolean' },
      'emit-stories': { type: 'boolean' },
      'wire-edges': { type: 'boolean' },
      ids: { type: 'string' },
      glob: { type: 'string' },
      severity: { type: 'string' },
      ledger: { type: 'string' },
      'ledger-commit': { type: 'boolean' },
      plan: { type: 'string' },
      out: { type: 'string' },
      'no-provider': { type: 'boolean' },
      'issues-file': { type: 'string' },
      'allow-missing-tally': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: false,
  });

  values.severity = validateSeverityFlag(values.severity);

  const json = (value) => JSON.stringify(value, null, 2);

  const runAutoSummary = async () =>
    (
      await runAutoImpl({
        glob: values.glob,
        severity: values.severity,
        dryRun: values['dry-run'],
        useProvider: !values['no-provider'],
        issuesFile: values['issues-file'],
        ledgerPath: values.ledger,
        ledgerCommit: values['ledger-commit'],
      })
    ).summary;

  // Runs after the summary is persisted: a broken remote must not cost the
  // sweep's findings.
  const commitLedger = async () => {
    if (!values['ledger-commit'] || values['dry-run']) return;
    Logger.warn(
      describeLedgerCommit(
        await runLedgerCommitImpl({ ledgerPath: values.ledger }),
      ),
    );
  };

  const scanPlan = () =>
    buildPlanImpl({
      glob: values.glob,
      severity: values.severity,
      useProvider: !values['no-provider'],
      issuesFile: values['issues-file'],
      allowMissingTally: values['allow-missing-tally'],
    });

  const seedMarkdown = () => {
    const plan = loadPlanImpl(values.plan);
    return buildPlanSeedMarkdownImpl({
      groups: plan.groups ?? [],
      findings: plan.findings ?? [],
      sourceReports: plan.sourceReports ?? [],
    });
  };

  const emittedStories = () => {
    const plan = loadPlanImpl(values.plan);
    const eligible = (plan.classifications ?? [])
      .filter((c) => c.action === 'create')
      .map((c) => c.group);
    const built = buildAndGateStoriesImpl(eligible, plan.edges ?? []);
    return values.json ? json(built) : renderStoryDrafts(built);
  };

  const wiredEdges = () =>
    wireEdgesImpl({
      plan: loadPlanImpl(values.plan),
      issueByGroupKey: parseIssueMapImpl(values.ids),
      ledgerPath: values.ledger,
      // The Issues really exist here, so recording defaults on.
      write: !values['dry-run'],
    });

  // [flag, render, newlineOnStdout, afterPersist?]
  const subcommands = [
    ['auto', async () => json(await runAutoSummary()), true, commitLedger],
    ['scan', async () => json(await scanPlan()), true],
    ['emit-plan-seed', () => seedMarkdown(), false],
    ['emit-stories', () => emittedStories(), true],
    ['wire-edges', async () => json(await wiredEdges()), true],
  ];

  const entry = subcommands.find(([flag]) => values[flag]);
  if (!entry) {
    throw new Error(
      'Usage: node audit-to-stories.js (--scan | --emit-plan-seed | --emit-stories | --wire-edges) [options]',
    );
  }
  const [, render, newlineOnStdout, after] = entry;
  persistImpl(await render(), values.out);
  if (newlineOnStdout && !values.out) stdout.write('\n');
  if (after) await after();
}

/**
 * Human-readable `--emit-stories` transcript. `dependsOn` is shown because the
 * blockers have no issue numbers yet (they are replayed via `--wire-edges`).
 * The Epic grouping block is text-only; `--json` stays a bare array.
 *
 * @param {Array<{ title: string, labels: string[], body: string, groupKey?: string, dependsOn?: string[] }>} built
 * @returns {string}
 */
function renderStoryDrafts(built) {
  const drafts = built
    .map((s, i) => {
      const deps = (s.dependsOn ?? []).length
        ? `\nDepends on group(s): ${s.dependsOn.join(', ')}`
        : '';
      return `--- story ${i + 1} ---\nTitle: ${s.title}\nLabels: ${s.labels.join(', ')}\nGroup key: ${s.groupKey}${deps}\n\n${s.body}\n`;
    })
    .join('\n');

  const grouping = formatEpicGrouping(built);
  return `${drafts}\n--- grouping ---\n${grouping}\n`;
}

async function main() {
  await runAuditToStories();
}

runAsCli(import.meta.url, main, {
  source: 'audit-to-stories',
  usage: {
    invocation:
      'node .agents/scripts/audit-to-stories.js (--scan | --auto | --emit-plan-seed | --emit-stories | --wire-edges) [options]',
    summary:
      'Turn audit-lens findings under temp/audits/ into a dedup-checked plan seed or standalone Stories.',
    flags: [
      ['--scan', 'Print the grouped, deduplicated plan as JSON.'],
      ['--auto', 'Run the full scan → file pipeline and print the summary.'],
      ['--emit-plan-seed', 'Emit a /mandrel-plan --seed-file document.'],
      ['--emit-stories', 'Emit the Story drafts as JSON.'],
      [
        '--wire-edges',
        'Second pass: resolve the detected group edges to blocked by #N footers plus native blocked_by relations, and record the mapped issues in the cross-run ledger as filed. Needs --plan and --ids; --dry-run suppresses the ledger write.',
      ],
      [
        '--ids <json|path>',
        'Group key → opened issue number, as JSON or a path to a JSON file. Required by --wire-edges.',
      ],
      ['--glob <pattern>', 'Override the audit-results glob.'],
      ['--severity <level>', 'Lowest severity to include (high|medium|low).'],
      [
        '--ledger <path>',
        `Path to the cross-run dedup ledger (default ${DEFAULT_LEDGER_PATH}).`,
      ],
      [
        '--ledger-commit',
        'After the --auto summary prints, commit a changed ledger onto chore/audit-ledger-<date>, push it, and open a PR against the base branch (never auto-merged). Ignored under --dry-run.',
      ],
      [
        '--plan <path>',
        'Read a previously emitted plan instead of re-scanning.',
      ],
      ['--out <path>', 'Write output to a file instead of stdout.'],
      ['--no-provider', 'Skip live GitHub dedup lookups (offline).'],
      [
        '--issues-file <path>',
        'Dedup against a JSON array of issues the host already fetched (every issue labelled audit::*, state all) instead of listing them through the provider. Lets dedup run where there is no gh CLI; composes with --no-provider.',
      ],
      [
        '--allow-missing-tally',
        'Downgrade a missing "Severity tally:" line to a warning (--scan only; --auto ignores it).',
      ],
      ['--json', 'Force JSON output.'],
      ['--dry-run', 'Report what would be filed; create nothing.'],
    ],
  },
});
