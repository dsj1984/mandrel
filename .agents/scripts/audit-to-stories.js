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
 *   --emit-epic-seed --plan <plan.json> --out <path>
 *     Read the plan envelope from disk, render the `/plan --idea`
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
import { parseAuditReports } from './lib/audit-to-stories/parse-audit-md.js';
import { buildEpicSeedMarkdown } from './lib/audit-to-stories/seed-epic-from-findings.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

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

async function loadProvider() {
  // The provider is optional — when missing, the dedupe step emits a
  // create-only classification and the workflow operator is informed.
  try {
    const mod = await import('./lib/provider-factory.js');
    const { resolveConfig } = await import('./lib/config-resolver.js');
    const config = resolveConfig();
    const provider = mod.createProvider(config ?? {});
    // The existing provider exposes higher-level ticket I/O. The dedupe
    // module only needs `findIssuesByFingerprint(sha)`. Adapt here so we
    // don't bake provider-shape knowledge into the dedupe module.
    if (typeof provider.searchIssues === 'function') {
      return {
        async findIssuesByFingerprint(sha) {
          const hits = await provider.searchIssues({
            query: sha,
            owner: config?.github?.owner,
            repo: config?.github?.repo,
          });
          return (hits ?? []).map((h) => ({
            number: h.number,
            state: h.state ?? h.state_reason ?? 'OPEN',
            body: h.body ?? '',
          }));
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

async function buildPlan({ glob: pattern, severity, useProvider }) {
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
      const result = await classifyGroupsAgainstGitHub({ groups, provider });
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
      ...summary,
    },
  };
}

function loadPlan(planPath) {
  if (!planPath) throw new Error('--plan <path> is required');
  return JSON.parse(fs.readFileSync(planPath, 'utf8'));
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
};

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      scan: { type: 'boolean' },
      'emit-epic-seed': { type: 'boolean' },
      'emit-stories': { type: 'boolean' },
      glob: { type: 'string' },
      severity: { type: 'string' },
      plan: { type: 'string' },
      out: { type: 'string' },
      'no-provider': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: false,
  });

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

  if (values['emit-epic-seed']) {
    const plan = loadPlan(values.plan);
    const md = buildEpicSeedMarkdown({
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
    const built = eligible.map((g) => buildStoryBody({ group: g }));
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
    'Usage: node audit-to-stories.js (--scan | --emit-epic-seed | --emit-stories) [options]',
  );
}

runAsCli(import.meta.url, main, { source: 'audit-to-stories' });
