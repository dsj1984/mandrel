/**
 * CLI: ratchet-down gate for the always-loaded documentation context budget
 * (Story #4438, Epic #4430 — Context Economy).
 *
 * Follows the standalone `check-arch-cycles.js` / `check-dead-exports.js`
 * precedent — a pure-Node, baseline-aware, sub-second checker wired into the
 * CI `baselines` job — rather than a `baselines/kinds/` metric. It measures the
 * live byte total of three documentation read-tiers against a single committed
 * budget in `baselines/context-budget.json`:
 *
 *   - `alwaysLoaded`  — the `CLAUDE.md` `@`-import closure re-paid on every
 *                       session and every subagent spawn (instructions.md § 4).
 *   - `mandatoryRead` — the resolved `project.docsContextFiles` set.
 *   - `workflow`      — the workflow **mandatory closure** (Story #4752): every
 *                       `.agents/workflows/**` entry point plus the transitive
 *                       closure of its `mandatoryReads:` frontmatter edges. The
 *                       companion **reachable** closure (per entry point) is
 *                       recorded under the top-level `workflowClosure` key.
 *
 * **One tier gates: `alwaysLoaded`.** It is the only tier every session and
 * every subagent spawn pays unconditionally, so growth there is a real tax on
 * every future turn. The other tiers are measured, recorded and printed, and
 * never fail the command (Story #5340). Demoting them is what makes workflow
 * prose editable again: under the old rule a prose fix had to be paid for with
 * an unrelated trim in the same commit, and that is how three reference
 * sections came to describe mechanisms the code had already retired. The
 * measurement is still worth seeing on every change, so it is kept as a
 * report rather than deleted. See `docs/decisions.md`, ADR 20260917-5340.
 *
 * The role-scoped agent-boot tier (`.agents/agents/*.md`) is recorded the same
 * way. Its former per-file 8 KB ceiling and the row-vs-tree drift gate are
 * gone with the same ADR — nothing enforces a per-file ceiling or a minimum
 * headroom on a workflow or agent file any more.
 *
 * A read-tier that resolves **empty** is skipped silently (the `docsContextFiles`
 * half skips when unconfigured / its files are absent), so a repo with no
 * `CLAUDE.md` and no context docs is a clean no-op.
 *
 * Ratchet semantics (mirroring the sibling ratchets):
 *   - The `alwaysLoaded` tier grows beyond `baseline.tiers.alwaysLoaded
 *     .totalBytes + baseline.toleranceBytes` → exit 1, naming the tier and its
 *     delta. Growth in any other measured tier is printed and exits 0.
 *   - A measured tier shrinks below its baseline total → **exit 0**, reported
 *     as an informational `-` line (Story #5313). This deliberately reverses
 *     Story #4872's "shrink fails" rule: that rule made every trim a red gate
 *     whose only remedy was a hand-run `--update`, so the gain was paid for
 *     twice. The concern it answered — a stale total silently absorbing the
 *     next growth — is now met by the close's write-back seam
 *     (`story-close/context-budget-writeback.js`), which rewrites the lower
 *     total into `baselines/context-budget.json` on the Story branch so the
 *     gain locks in without a failing gate. Shrinkage stays zero-tolerance
 *     in the *report* (every byte under the total is listed) so a sub-
 *     tolerance gain is never discarded by the write-back either.
 *   - A recorded `alwaysLoaded` row naming a path the measured tier no longer
 *     contains → exit 1. The row describes a file that has been deleted or
 *     de-listed, so the bytes it contributes to the recorded total are fiction.
 *     The same drift in a report-only tier is printed, not failed.
 *   - Within tolerance / clean → exit 0.
 *   - Baseline file absent → warn + exit 0 (no-op; nothing to ratchet against).
 *
 * Tolerance lives in the baseline JSON (`toleranceBytes`) — there is **no**
 * `.agentrc.json` config key; this is a framework-internal dogfooding ratchet,
 * like arch-cycles.
 *
 * Flags:
 *   --baseline <path>  override the budget path (default
 *                      `baselines/context-budget.json`, resolved from cwd).
 *   --root <path>      resolve tiers against an explicit repo root (default cwd).
 *   --update           reseed the baseline from the current measurement (keeps
 *                      the existing `toleranceBytes`, or defaults it) and exit 0.
 *   --json             write the structured envelope to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { resolveDocTiers, tierTotalBytes } from './lib/doc-tiers.js';

/**
 * The tiers this command measures and records (in report order).
 * `digestVisible`, `onDemand` and `workflowOnDemand` are resolved by the tier
 * map for the lens, but the byte budget intentionally measures only the tiers
 * a session is *forced* to read.
 * @type {Array<'alwaysLoaded' | 'mandatoryRead' | 'workflow'>}
 */
export const MEASURED_TIERS = ['alwaysLoaded', 'mandatoryRead', 'workflow'];

/**
 * The tiers whose drift fails the command (Story #5340). Only `alwaysLoaded`
 * is paid by every session and every subagent spawn unconditionally, so it is
 * the one tier where growth is a tax nobody opted into. Everything else in
 * {@link MEASURED_TIERS} is a report.
 * @type {Array<'alwaysLoaded'>}
 */
export const ENFORCED_TIERS = ['alwaysLoaded'];

/**
 * Default tolerance (bytes) seeded into a fresh baseline by `--update` when the
 * existing baseline carries none.
 * @type {number}
 */
export const DEFAULT_TOLERANCE_BYTES = 2048;

/**
 * Parse argv for `--baseline <path>`, `--root <path>`, `--update`, `--json`.
 * Exported so unit tests can pin the parser.
 *
 * @param {string[]} argv
 * @returns {{ baselinePath: string|null, rootPath: string|null, update: boolean, json: boolean }}
 */
export function parseArgv(argv = []) {
  let baselinePath = null;
  let rootPath = null;
  let update = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--baseline') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        baselinePath = next;
        i += 1;
      }
    } else if (a === '--root') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        rootPath = next;
        i += 1;
      }
    } else if (a === '--update') {
      update = true;
    } else if (a === '--json') {
      json = true;
    }
  }
  return { baselinePath, rootPath, update, json };
}

/**
 * Read the committed budget envelope from disk. Returns the parsed object or
 * `null` when the file is missing or unparseable.
 *
 * @param {string} baselinePath
 * @returns {{ toleranceBytes?: number, tiers?: Record<string, { totalBytes: number, files?: Array<{ path: string, bytes: number }> }> } | null}
 */
export function loadBaseline(baselinePath) {
  try {
    if (!fs.existsSync(baselinePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the committed-baseline envelope from a resolved tier map. Only the
 * measured tiers are recorded (each as `{ totalBytes, files }`).
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {number} toleranceBytes
 * @returns {object}
 */
export function buildBaseline(tierMap, toleranceBytes) {
  const tiers = {};
  for (const name of MEASURED_TIERS) {
    const files = tierMap.tiers[name] ?? [];
    tiers[name] = { totalBytes: tierTotalBytes(files), files };
  }
  // The agent-boot tier is recorded top-level (not under `tiers`) because it
  // carries no recorded total to diff against — it is a per-file size record
  // the audit instruments read as hotspot rows. Keeping it out of `tiers`
  // keeps the ratchet diff loop unambiguous.
  const agentBootFiles = (tierMap.tiers.agentBoot ?? []).map((f) => ({
    path: f.path,
    bytes: f.bytes,
  }));
  return {
    $schema: 'https://mandrel.dev/baselines/context-budget.schema.json',
    generatedAt: new Date().toISOString(),
    toleranceBytes,
    tiers,
    agentBoot: {
      files: agentBootFiles,
    },
    // Recorded, never gated (#4752): the total reachable closure per workflow
    // entry point.
    workflowClosure: {
      reachableTotalBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
      entryPoints: tierMap.workflowClosure?.entryPoints ?? [],
    },
  };
}

/**
 * Collect the recorded rows of one measured tier that name a path the measured
 * tier no longer contains (Story #4872). A deleted file drops out of the
 * resolved tier, and so does one that has been de-listed from the read set —
 * either way the row's bytes are counted into a recorded total that no live
 * file backs, so the row is drift and not a detail.
 *
 * @param {string} tier
 * @param {Array<{ path: string, bytes: number }>} files live tier measurement
 * @param {{ files?: Array<{ path: string, bytes?: number }> }} baseTier recorded tier
 * @returns {Array<{ tier: string, path: string, bytes: number|null }>}
 */
function absentRows(tier, files, baseTier) {
  const live = new Set(files.map((f) => f.path));
  const out = [];
  for (const row of baseTier?.files ?? []) {
    if (typeof row?.path !== 'string' || live.has(row.path)) continue;
    out.push({
      tier,
      path: row.path,
      bytes: Number.isFinite(row.bytes) ? row.bytes : null,
    });
  }
  return out;
}

/**
 * Pure diff: compare the current tier map against the committed baseline. A
 * measured tier with no current files is skipped; a tier absent from the
 * baseline is skipped. `grown` and `absent` entries in an {@link
 * ENFORCED_TIERS} tier fail the gate; every other entry — and every `shrunk`
 * entry — is reported (Story #5340, Story #5313) and `shrunk` is what the
 * close writes back. See the ratchet semantics in the module header.
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {{ toleranceBytes?: number, tiers?: Record<string, { totalBytes: number }> }} baseline
 * @returns {{
 *   grown: Array<{ tier: string, current: number, baseline: number, tolerance: number, delta: number }>,
 *   shrunk: Array<{ tier: string, current: number, baseline: number, delta: number }>,
 *   absent: Array<{ tier: string, path: string, bytes: number|null }>,
 *   skipped: string[],
 * }}
 */
export function diffBudget(tierMap, baseline) {
  const tolerance = Number.isFinite(baseline?.toleranceBytes)
    ? baseline.toleranceBytes
    : 0;
  const grown = [];
  const shrunk = [];
  const absent = [];
  const skipped = [];
  for (const tier of MEASURED_TIERS) {
    const files = tierMap.tiers[tier] ?? [];
    const current = tierTotalBytes(files);
    const baseTier = baseline?.tiers?.[tier];
    if (
      files.length === 0 ||
      !baseTier ||
      !Number.isFinite(baseTier.totalBytes)
    ) {
      skipped.push(tier);
      continue;
    }
    const baselineBytes = baseTier.totalBytes;
    if (current > baselineBytes + tolerance) {
      grown.push({
        tier,
        current,
        baseline: baselineBytes,
        tolerance,
        delta: current - baselineBytes,
      });
    } else if (current < baselineBytes) {
      // Deliberately zero-tolerance in the report: `tolerance` guards against
      // churn from a trivial *addition*; mirroring it downward would hide a
      // gain from the write-back that locks it in (Story #5313).
      shrunk.push({
        tier,
        current,
        baseline: baselineBytes,
        delta: baselineBytes - current,
      });
    }
    absent.push(...absentRows(tier, files, baseTier));
  }
  return { grown, shrunk, absent, skipped };
}

/**
 * True when a diff entry belongs to a tier whose drift still fails the gate.
 *
 * @param {{ tier?: string }} entry
 * @returns {boolean}
 */
function isEnforced(entry) {
  return ENFORCED_TIERS.includes(entry?.tier);
}

/**
 * Count the drift entries that fail the gate: growth past tolerance and a
 * recorded row the tree no longer backs, **in an {@link ENFORCED_TIERS} tier
 * only** (Story #5340). Shrinkage is not in the set (Story #5313 — the close
 * writes it back instead). This is the one place the failure set is defined
 * and both the summary tag and the exit code read it.
 *
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {number}
 */
export function budgetFailureCount(diff) {
  const grown = (diff?.grown ?? []).filter(isEnforced).length;
  const absent = (diff?.absent ?? []).filter(isEnforced).length;
  return grown + absent;
}

/**
 * Render the human-readable diff. `+` lines are enforced tiers that grew
 * beyond tolerance; `-` lines are tiers that shrank below their recorded total
 * (informational — the close writes the lower total back) or rows naming a
 * path the tree no longer carries. Drift in a report-only tier is prefixed
 * with `~` and says so on the line, so a reader never has to cross-reference
 * {@link ENFORCED_TIERS} to know whether it broke the build. A one-line
 * summary always follows.
 *
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {string}
 */
export function renderDiff(diff) {
  const lines = [];
  const report = ' — reported, never gated';
  for (const g of diff.grown) {
    const gated = isEnforced(g);
    lines.push(
      `${gated ? '+' : '~'} ${g.tier}: ${g.current} bytes exceeds budget ${g.baseline} + tolerance ${g.tolerance} (delta +${g.delta})${gated ? '' : report}`,
    );
  }
  for (const s of diff.shrunk) {
    lines.push(
      `- ${s.tier}: ${s.current} bytes is under the recorded ${s.baseline} (delta -${s.delta}) — the close writes the lower total back to baselines/context-budget.json when this branch lands`,
    );
  }
  for (const a of diff.absent ?? []) {
    const gated = isEnforced(a);
    lines.push(
      `${gated ? '-' : '~'} ${a.tier}: recorded row ${a.path} names a path the measured tier no longer contains — refresh baselines/context-budget.json${gated ? '' : report}`,
    );
  }
  const tag = budgetFailureCount(diff) > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[context-budget] grown=${diff.grown.length} shrunk=${diff.shrunk.length} absent=${diff.absent?.length ?? 0} skipped=${diff.skipped.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * Render the workflow **reachable** closure line — recorded, never gated
 * (Story #4752). Returns `''` when there is no workflow tier to report, so the
 * caller can stay a one-liner.
 *
 * @param {{ workflowClosure?: { reachableTotalBytes?: number, entryPoints?: unknown[] } }} tierMap
 * @param {{ workflowClosure?: { reachableTotalBytes?: number } } | null} [baseline]
 * @returns {string}
 */
export function renderReachable(tierMap, baseline) {
  const closure = tierMap?.workflowClosure;
  const current = closure?.reachableTotalBytes ?? 0;
  if (current <= 0) return '';
  const recorded = baseline?.workflowClosure?.reachableTotalBytes;
  const against = Number.isFinite(recorded) ? ` (recorded ${recorded})` : '';
  const entries = closure.entryPoints?.length ?? 0;
  return `  workflow reachable closure: ${current} bytes across ${entries} entry points${against} — drift signal, never gated`;
}

/**
 * Render the role-scoped agent-boot line — a pure size report since Story
 * #5340 removed the per-file ceiling. It names the largest boot context
 * because that is the number an author sizing a role-def edit wants, and the
 * total because that is what the whole role surface costs. Returns `''` when
 * the tree carries no role defs.
 *
 * @param {{ tiers?: { agentBoot?: Array<{ path: string, bytes: number }> } }} tierMap
 * @returns {string}
 */
function renderAgentBoot(tierMap) {
  const files = tierMap?.tiers?.agentBoot ?? [];
  if (files.length === 0) return '';
  const largest = files.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  return `  agentBoot: ${tierTotalBytes(files)} bytes across ${files.length} role defs, largest ${largest.path} at ${largest.bytes} — reported, never gated`;
}

/**
 * Top-level CLI entry. Exported so tests can drive the full pipeline against a
 * tmpdir fixture with an injected config and sinks.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   config?: object,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} 0 = clean / within tolerance / shrink-only / no-op;
 *   1 = the always-loaded tier grew beyond tolerance or one of its recorded
 *   rows is unbacked
 */
/**
 * Write a fresh budget, preserving the recorded tolerance so `--update` never
 * silently widens the gate it is refreshing.
 *
 * @param {object} params
 * @returns {0}
 */
function writeUpdatedBaseline({ tierMap, resolvedBaselinePath, json, stdout }) {
  const existing = loadBaseline(resolvedBaselinePath);
  const tolerance = Number.isFinite(existing?.toleranceBytes)
    ? existing.toleranceBytes
    : DEFAULT_TOLERANCE_BYTES;
  const envelope = buildBaseline(tierMap, tolerance);
  fs.mkdirSync(path.dirname(resolvedBaselinePath), { recursive: true });
  fs.writeFileSync(
    resolvedBaselinePath,
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  if (!json) {
    stdout.write(
      `[context-budget] wrote baseline ${resolvedBaselinePath} (tolerance ${tolerance} bytes)\n`,
    );
  } else {
    stdout.write(
      `${JSON.stringify({ kind: 'context-budget-update', baselinePath: resolvedBaselinePath, envelope }, null, 2)}\n`,
    );
  }
  return 0;
}

/**
 * An absent budget is a no-op, not a failure: a consumer that has never
 * recorded one has nothing to regress against.
 *
 * @param {object} params
 * @returns {0}
 */
function reportMissingBaseline({
  tierMap,
  resolvedBaselinePath,
  json,
  stdout,
  stderr,
}) {
  if (json) {
    stdout.write(
      `${JSON.stringify({ kind: 'context-budget-report', baselinePath: resolvedBaselinePath, tiers: tierMap.tiers, grown: [], shrunk: [], absent: [], skipped: MEASURED_TIERS, exitCode: 0, noBaseline: true }, null, 2)}\n`,
    );
  } else {
    stderr.write(
      `[context-budget] ⚠ budget not found at ${resolvedBaselinePath} — skipping (no-op)\n`,
    );
  }
  return 0;
}

/**
 * Score the tree against the recorded budget. Pure — every verdict the two
 * renderers below present is decided here, so they cannot disagree about what
 * failed or drift apart in which fields they surface.
 *
 * @param {{ tierMap: object, baseline: object }} params
 * @returns {{ diff: object, exitCode: 0 | 1 }}
 */
function evaluateBudget({ tierMap, baseline }) {
  const diff = diffBudget(tierMap, baseline);
  return { diff, exitCode: budgetFailureCount(diff) > 0 ? 1 : 0 };
}

/**
 * @param {object} params
 * @returns {void}
 */
function renderJsonReport({
  tierMap,
  baseline,
  resolvedBaselinePath,
  report,
  stdout,
}) {
  const { diff, exitCode } = report;
  const envelope = {
    kind: 'context-budget-report',
    baselinePath: resolvedBaselinePath,
    toleranceBytes: Number.isFinite(baseline.toleranceBytes)
      ? baseline.toleranceBytes
      : 0,
    current: Object.fromEntries(
      MEASURED_TIERS.map((t) => [t, tierTotalBytes(tierMap.tiers[t] ?? [])]),
    ),
    grown: diff.grown,
    shrunk: diff.shrunk,
    absent: diff.absent,
    skipped: diff.skipped,
    enforcedTiers: ENFORCED_TIERS,
    agentBoot: tierMap.tiers?.agentBoot ?? [],
    workflowReachableBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
    exitCode,
  };
  stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * Each failing condition gets its own remediation line: they are fixed
 * differently, so a single generic message would leave the author guessing
 * which applies. Only {@link ENFORCED_TIERS} drift speaks here — the report-
 * only lines are already marked `~` in the preview above.
 *
 * @param {object} params
 * @returns {void}
 */
function renderFailureDiagnostics({ report, stderr }) {
  const { diff } = report;
  if (diff.grown.some(isEnforced)) {
    stderr.write(
      `[context-budget] ❌ the always-loaded documentation tier grew beyond tolerance — every session and every subagent spawn re-pays it. Refresh the budget consciously with \`node .agents/scripts/check-context-budget.js --update\` once the growth is intentional\n`,
    );
  }
  if (diff.absent.some(isEnforced)) {
    stderr.write(
      `[context-budget] ❌ a recorded always-loaded row names a path the measured tier no longer contains — its bytes inflate the recorded total against nothing. Refresh with \`node .agents/scripts/check-context-budget.js --update\`\n`,
    );
  }
}

/**
 * @param {object} params
 * @returns {void}
 */
function renderTextReport({ tierMap, baseline, report, stdout, stderr }) {
  const { diff, exitCode } = report;
  stdout.write(`\n--- context-budget preview ---\n`);
  stdout.write(`${renderDiff(diff)}\n`);
  const reachable = renderReachable(tierMap, baseline);
  if (reachable) stdout.write(`${reachable}\n`);
  const boot = renderAgentBoot(tierMap);
  if (boot) stdout.write(`${boot}\n`);
  if (exitCode === 1) renderFailureDiagnostics({ report, stderr });
}

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  config,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { baselinePath, rootPath, update, json } = parseArgv(argv);
  const root = rootPath ? path.resolve(cwd, rootPath) : path.resolve(cwd);
  const resolvedBaselinePath = path.resolve(
    cwd,
    baselinePath ?? path.join('baselines', 'context-budget.json'),
  );
  const resolvedConfig = config ?? resolveConfig();
  const tierMap = resolveDocTiers(resolvedConfig, { root });

  if (update) {
    return writeUpdatedBaseline({
      tierMap,
      resolvedBaselinePath,
      json,
      stdout,
    });
  }

  const baseline = loadBaseline(resolvedBaselinePath);
  if (!baseline) {
    return reportMissingBaseline({
      tierMap,
      resolvedBaselinePath,
      json,
      stdout,
      stderr,
    });
  }

  const report = evaluateBudget({ tierMap, baseline });
  if (json) {
    renderJsonReport({
      tierMap,
      baseline,
      resolvedBaselinePath,
      report,
      stdout,
    });
  } else {
    renderTextReport({ tierMap, baseline, report, stdout, stderr });
  }

  return report.exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'context-budget',
  propagateExitCode: true,
  errorPrefix: '[context-budget] ❌ Fatal error',
});
