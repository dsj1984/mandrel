/**
 * audit-to-stories.js — Convert audit-* report findings into actionable
 * GitHub Story proposals.
 *
 * The CLI exposes three deterministic sub-commands the host workflow
 * (`/audit-to-stories`) invokes between HITL gates:
 *
 *   --scan [--glob <pattern>] [--severity <threshold>]
 *     Parse every audit-*-results.md under the glob, normalise findings,
 *     stamp fingerprints, group cross-audit, and (when a provider is
 *     available) classify each group as create / skip-open / skip-reoccurring.
 *     Emits a single `audit-to-stories-plan.json` envelope to --out (or
 *     stdout when --json is set).
 *
 *   --emit-plan-seed --plan <plan.json> --out <path>
 *     Read the plan envelope from disk, render the `/plan --seed`
 *     seed markdown, persist to --out.
 *
 *   --emit-stories --plan <plan.json>
 *     Read the plan envelope from disk, render the per-group `{ title,
 *     body, labels }` objects. The host LLM consumes the JSON and calls
 *     the GitHub provider (gh / mcp__github__issue_write) to open one
 *     Issue per group.
 *
 * Per .agents/rules/orchestration-error-handling.md, this CLI throws on
 * unrecoverable failure rather than calling Logger.fatal so runAsCli's
 * exit-code boundary stays robust under mocked process.exit.
 */

import fs from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { buildStoryBody } from './lib/audit-to-stories/build-story-body.js';
import { classifyGroupsAgainstGitHub } from './lib/audit-to-stories/dedupe-against-github.js';
import { withFingerprints } from './lib/audit-to-stories/finding-adapter.js';
import { groupFindings } from './lib/audit-to-stories/group-findings.js';
import {
  DEFAULT_LEDGER_PATH,
  readLedger,
  reconcileLedger,
  writeLedger,
} from './lib/audit-to-stories/ledger.js';
import { parseAuditReports } from './lib/audit-to-stories/parse-audit-md.js';
import { buildPlanSeedMarkdown } from './lib/audit-to-stories/seed-from-findings.js';
import { runAsCli } from './lib/cli-utils.js';
import { searchSemanticCandidates } from './lib/findings/semantic-issue-search.js';
import { Logger } from './lib/Logger.js';
import { parse as parseStoryBody } from './lib/story-body/story-body.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const DEFAULT_GLOB = 'temp/audits/audit-*-results.md';
const FAN_OUT_REPORT = 'audit-fan-out-results.md';

function meetsSeverity(finding, threshold) {
  if (!threshold || threshold === 'all') return true;
  const minRank = SEVERITY_RANK[threshold] ?? 0;
  const fRank = SEVERITY_RANK[finding.severity] ?? 0;
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

function tallyBySeverity(findings) {
  const t = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const f of findings) {
    if (Object.hasOwn(t, f.severity)) t[f.severity] += 1;
    else t.unknown += 1;
  }
  return t;
}

async function loadProvider({ createProviderImpl, resolveConfigImpl } = {}) {
  // The provider is optional — when missing, the dedupe step emits a
  // create-only classification and the workflow operator is informed. The
  // `createProviderImpl` / `resolveConfigImpl` seams let a contract test drive
  // this exact adapter (fingerprint + semantic-candidate ports) with an
  // in-memory issue store instead of the live GitHub provider.
  try {
    const resolveConfig =
      resolveConfigImpl ??
      (await import('./lib/config-resolver.js')).resolveConfig;
    const createProvider =
      createProviderImpl ??
      (await import('./lib/provider-factory.js')).createProvider;
    const config = resolveConfig();
    const provider = createProvider(config ?? {});
    // The existing provider exposes higher-level ticket I/O. The dedupe
    // module needs `findIssuesByFingerprint(sha)` for the exact-fingerprint
    // pass and — since Story #4626 — a `searchCandidates(finding)` port for
    // the meaning-first Stage-1 pass. Adapt both here so we don't bake
    // provider-shape knowledge into the dedupe module.
    if (typeof provider.searchIssues === 'function') {
      const owner = config?.github?.owner;
      const repo = config?.github?.repo;
      const normalise = (h) => ({
        number: h.number,
        state: (h.state ?? h.state_reason ?? 'open')
          .toString()
          .toLowerCase()
          .includes('closed')
          ? 'closed'
          : 'open',
        title: h.title ?? '',
        body: h.body ?? '',
      });
      return {
        async findIssuesByFingerprint(sha) {
          const hits = await provider.searchIssues({ query: sha, owner, repo });
          return (hits ?? []).map(normalise);
        },
        async searchCandidates(finding) {
          // Wire the shared semantic search onto the provider's full-text
          // issue search (open + closed) so route-finding's Stage-1 pass runs.
          const search = async (query) => {
            if (!query || query.trim().length === 0) return [];
            const hits = await provider.searchIssues({ query, owner, repo });
            return (hits ?? []).map(normalise);
          };
          return searchSemanticCandidates(finding, { search });
        },
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Render the loud, operator-visible warning emitted when the Phase 6 dedup
 * does NOT run against real GitHub issues. Two distinct reasons:
 *
 *   - `'no-provider-port'` — the configured provider resolved but exposes no
 *     `searchIssues` port (or `loadProvider()` threw). This is the
 *     silent-no-op the workflow's "Never open a duplicate Issue" contract
 *     was failing on: every group classifies `create` and the operator gets
 *     zero automated dedup signal. Surfacing it loudly is the whole point.
 *   - `'disabled'` — the operator passed `--no-provider`, intentionally
 *     skipping dedup. Still warned (so a re-run that opens duplicates is
 *     never a surprise), but framed as a deliberate choice.
 *
 * Pure: returns the message string so `buildPlan` owns the single
 * `Logger.warn` write site and the text stays unit-testable.
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

async function buildPlan({ glob: pattern, severity, useProvider, ledger }) {
  const reportPaths = await collectReportPaths(pattern ?? DEFAULT_GLOB);
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
      },
    };
  }

  const reports = readReports(reportPaths);
  const allFindings = parseAuditReports(reports);
  const filtered = allFindings.filter((f) => meetsSeverity(f, severity));
  const stamped = withFingerprints(filtered);
  const { groups, edges } = groupFindings(stamped);

  let classifications = groups.map((g) => ({
    group: g,
    action: 'create',
    matchedIssues: [],
    matchedFingerprints: [],
  }));
  let summary = { create: groups.length, skipOpen: 0, skipReoccurring: 0 };
  let dedupApplied = false;

  if (useProvider) {
    const provider = await loadProvider();
    if (provider) {
      const result = await classifyGroupsAgainstGitHub({
        groups,
        provider,
        searchCandidates: provider.searchCandidates,
      });
      classifications = result.classifications;
      summary = result.summary;
      dedupApplied = true;
    } else {
      // The provider could not resolve a searchIssues port — the dedup gate
      // is silently a no-op without this. Surface it loudly (stderr, so the
      // --scan JSON on stdout stays clean) so the operator does not read a
      // create-only plan as "no duplicates found".
      Logger.warn(dedupSkippedWarning('no-provider-port'));
    }
  } else {
    // Operator explicitly opted out via --no-provider. Still warn so a
    // duplicate-opening re-run is never a surprise.
    Logger.warn(dedupSkippedWarning('disabled'));
  }

  // Cross-run ledger (Story #4626): fold this scan onto the committed memory,
  // suppress findings a prior run recorded as accepted-risk, and (unless the
  // caller asked not to write) persist the updated ledger. Opt-in — the plain
  // --scan path leaves it untouched so it never mutates a committed file.
  let ledgerSummary;
  if (ledger) {
    const suppressed = reconcileScanLedger({
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
      dedupApplied,
      ...(ledgerSummary ? { ledger: ledgerSummary } : {}),
      ...summary,
    },
  };
}

/**
 * Fold the current scan onto the committed cross-run ledger and persist it.
 * Returns the set of finding fingerprints the ledger says are accepted-risk
 * (deliberately rejected) so the caller can suppress them.
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
  });
  if (write !== false) writeLedger(ledgerPath, next);
  return new Set(
    next.entries
      .filter((e) => e.status === 'accepted-risk')
      .map((e) => e.fingerprint),
  );
}

/**
 * Derive a `{ fingerprint → issueState }` map from dedupe classifications so
 * the ledger reconcile sees the live open/closed state of matched Issues.
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

const DEFAULT_SEVERITY_FLOOR = 'high';

/**
 * Resolve the unattended-sweep severity floor: an explicit `--severity` wins,
 * else `delivery.auditToStories.severityFloor` from config, else the built-in
 * default (`high`). Reads config defensively so a missing/failed resolve never
 * breaks the run.
 *
 * @param {string|undefined} explicit
 * @returns {Promise<string>}
 */
async function resolveSeverityFloor(explicit) {
  if (explicit) return explicit;
  try {
    const { resolveConfig } = await import('./lib/config-resolver.js');
    const config = resolveConfig();
    const floor = config?.delivery?.auditToStories?.severityFloor;
    if (typeof floor === 'string' && floor.length > 0) return floor;
  } catch (_) {
    // fall through to default
  }
  return DEFAULT_SEVERITY_FLOOR;
}

/**
 * Unattended `--auto` sweep. No interactive gates: it resolves the severity
 * floor from config, builds the plan (with cross-run ledger reconciliation),
 * and reports a run summary. Under `--dry-run` it performs zero GitHub writes
 * and emits the summary only; otherwise it returns the create-eligible Story
 * payloads for the caller to open. Always resolves — never prompts.
 *
 * @param {object} params
 * @param {string} [params.glob]
 * @param {string} [params.severity] — explicit floor override.
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.useProvider]
 * @param {string} [params.ledgerPath]
 * @returns {Promise<{ summary: object, stories: Array<object> }>}
 */
async function runAuto({ glob, severity, dryRun, useProvider, ledgerPath }) {
  const floor = await resolveSeverityFloor(severity);
  const plan = await buildPlan({
    glob,
    severity: floor,
    useProvider,
    ledger: { path: ledgerPath ?? DEFAULT_LEDGER_PATH, write: !dryRun },
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
    // Re-detected open Issues the operator may want a "re-detected" comment on.
    reDetected: byAction.skipOpen
      .flatMap((c) => c.matchedIssues ?? [])
      .map((i) => i.number)
      .filter((n) => typeof n === 'number'),
    ledger: plan.summary?.ledger ?? null,
  };

  return { summary, stories };
}

/**
 * Build every eligible group into a `{ title, body, labels }` Story object and
 * gate the batch against the inline-contract bar BEFORE any issue is opened.
 *
 * The `--emit-stories` path opens GitHub issues directly (no decomposer
 * round-trip), so `assertEveryStoryHasInlineContract` never runs against these
 * bodies. This gate restores that guarantee at the standalone seam: each
 * emitted body is re-parsed through the canonical `story-body` parser and must
 * carry a non-empty `acceptance[]` AND a non-empty `verify[]`. A body that
 * fails throws, surfacing the gap instead of opening an ungated Story
 * (Story #4270).
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
  loadProvider,
  dedupSkippedWarning,
  buildAndGateStories,
  runAuto,
  resolveSeverityFloor,
  reconcileScanLedger,
  issueStatesFromClassifications,
};

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      scan: { type: 'boolean' },
      auto: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'emit-plan-seed': { type: 'boolean' },
      'emit-stories': { type: 'boolean' },
      glob: { type: 'string' },
      severity: { type: 'string' },
      ledger: { type: 'string' },
      plan: { type: 'string' },
      out: { type: 'string' },
      'no-provider': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: false,
  });

  if (values.auto) {
    const { summary } = await runAuto({
      glob: values.glob,
      severity: values.severity,
      dryRun: values['dry-run'],
      useProvider: !values['no-provider'],
      ledgerPath: values.ledger,
    });
    persist(JSON.stringify(summary, null, 2), values.out);
    if (!values.out) process.stdout.write('\n');
    return;
  }

  if (values.scan) {
    const plan = await buildPlan({
      glob: values.glob,
      severity: values.severity,
      useProvider: !values['no-provider'],
    });
    const out = JSON.stringify(plan, null, 2);
    persist(out, values.out);
    if (!values.out) process.stdout.write('\n');
    return;
  }

  if (values['emit-plan-seed']) {
    const plan = loadPlan(values.plan);
    const md = buildPlanSeedMarkdown({
      groups: plan.groups ?? [],
      findings: plan.findings ?? [],
      sourceReports: plan.sourceReports ?? [],
    });
    persist(md, values.out);
    return;
  }

  if (values['emit-stories']) {
    const plan = loadPlan(values.plan);
    const eligible = (plan.classifications ?? [])
      .filter((c) => c.action === 'create')
      .map((c) => c.group);
    const built = buildAndGateStories(eligible, plan.edges ?? []);
    const out = values.json
      ? JSON.stringify(built, null, 2)
      : built
          .map(
            (s, i) =>
              `--- story ${i + 1} ---\nTitle: ${s.title}\nLabels: ${s.labels.join(', ')}\n\n${s.body}\n`,
          )
          .join('\n');
    persist(out, values.out);
    if (!values.out) process.stdout.write('\n');
    return;
  }

  throw new Error(
    'Usage: node audit-to-stories.js (--scan | --emit-plan-seed | --emit-stories) [options]',
  );
}

runAsCli(import.meta.url, main, { source: 'audit-to-stories' });
