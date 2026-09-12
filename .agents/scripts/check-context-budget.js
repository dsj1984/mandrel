/**
 * CLI: ratchet-down gate for the always-loaded documentation context budget
 * (Story #4438, Epic #4430 — Context Economy).
 *
 * Follows the standalone `check-arch-cycles.js` / `check-dead-exports.js`
 * precedent — a pure-Node, baseline-aware, sub-second checker wired into the
 * CI `baselines` job — rather than a `baselines/kinds/` metric. It measures the
 * live byte total of two documentation read-tiers and compares each against a
 * single committed budget in `baselines/context-budget.json`:
 *
 *   - `alwaysLoaded`  — the `CLAUDE.md` `@`-import closure re-paid on every
 *                       session and every subagent spawn (instructions.md § 4).
 *   - `mandatoryRead` — the resolved `project.docsContextFiles` set.
 *   - `workflow`      — the workflow **mandatory closure** (Story #4752): every
 *                       `.agents/workflows/**` entry point plus the transitive
 *                       closure of its `mandatoryReads:` frontmatter edges. The
 *                       companion **reachable** closure (per entry point) is
 *                       recorded under the top-level `workflowClosure` key as a
 *                       drift signal and never gates — growth there is a
 *                       reading-cost signal, not a contract violation.
 *
 * It additionally enforces a **per-file** ceiling on the role-scoped agent-boot
 * tier (`.agents/agents/*.md`, #4478): no single boot context may exceed
 * `agentBoot.ceilingBytes` (default 8192). This is a per-agent cap, not a sum
 * ratchet — each role def is a standalone system prompt a converted spawn boots
 * on, and adding another role def is legitimate.
 *
 * The recorded `agentBoot` rows are additionally held **in sync with the tree**
 * (Story #4830), because those rows are what an author sizes an edit against.
 * The two drift directions are deliberately asymmetric:
 *
 *   - **permissive** (the row understates the file, or no row exists) — the row
 *     promises headroom that does not exist, the gate stays green, and the
 *     shortfall only lands as a ceiling failure once the edit is written. This
 *     fails the gate.
 *   - **restrictive** (the row overstates the file) — an author under-spends
 *     and the ceiling is never surprised, so it is self-correcting. Reported as
 *     a `-` line; exit stays 0.
 *
 * Each row also records its `headroomBytes` under the ceiling, so the budget an
 * author reads is stated rather than re-derived.
 *
 * A read-tier that resolves **empty** is skipped silently (the `docsContextFiles`
 * half skips when unconfigured / its files are absent), so a repo with no
 * `CLAUDE.md` and no context docs is a clean no-op.
 *
 * Ratchet semantics (mirroring the sibling ratchets):
 *   - A gated tier grows beyond `baseline.tiers.<tier>.totalBytes +
 *     baseline.toleranceBytes` → exit 1, naming the tier and its delta.
 *   - A gated tier shrinks below its baseline total → **exit 0**, reported as
 *     an informational `-` line (Story #5313). This deliberately reverses
 *     Story #4872's "shrink fails" rule: that rule made every trim a red gate
 *     whose only remedy was a hand-run `--update`, so the gain was paid for
 *     twice. The concern it answered — a stale total silently absorbing the
 *     next growth — is now met by the close's write-back seam
 *     (`story-close/context-budget-writeback.js`), which rewrites the lower
 *     total into `baselines/context-budget.json` on the Story branch so the
 *     gain locks in without a failing gate. Shrinkage stays zero-tolerance
 *     in the *report* (every byte under the total is listed) so a sub-
 *     tolerance gain is never discarded by the write-back either.
 *   - A recorded row naming a path the measured tier no longer contains →
 *     exit 1. The row describes a file that has been deleted or de-listed, so
 *     the bytes it contributes to the recorded total are fiction.
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
 * The tiers this ratchet gates (in report order). `digestVisible`, `onDemand`
 * and `workflowOnDemand` are resolved by the tier map for the lens, but the
 * byte budget intentionally gates only the tiers a session is *forced* to read.
 * @type {Array<'alwaysLoaded' | 'mandatoryRead' | 'workflow'>}
 */
export const GATED_TIERS = ['alwaysLoaded', 'mandatoryRead', 'workflow'];

/**
 * Default tolerance (bytes) seeded into a fresh baseline by `--update` when the
 * existing baseline carries none.
 * @type {number}
 */
export const DEFAULT_TOLERANCE_BYTES = 2048;

/**
 * Per-file ceiling (bytes) for the role-scoped agent-boot tier (#4478). Unlike
 * the read-tiers (gated by a total-byte ratchet), each `.agents/agents/*.md`
 * boot context is a **standalone** system prompt a converted spawn boots on, so
 * the meaningful budget is per-agent, not the sum: no single role def may
 * exceed this ceiling. Adding another role def is legitimate — a per-file gate
 * (rather than a sum ratchet) does not false-positive on that.
 * @type {number}
 */
export const AGENT_BOOT_CEILING_BYTES = 8192;

/**
 * Return the agent-boot files that exceed the per-file ceiling.
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {number} ceiling
 * @returns {Array<{ path: string, bytes: number, ceiling: number }>}
 */
export function agentBootOverflow(tierMap, ceiling = AGENT_BOOT_CEILING_BYTES) {
  const files = tierMap?.tiers?.agentBoot ?? [];
  return files
    .filter((f) => Number.isFinite(f?.bytes) && f.bytes > ceiling)
    .map((f) => ({ path: f.path, bytes: f.bytes, ceiling }));
}

/**
 * Classify one agent-boot file against its recorded baseline row (#4830).
 * Returns `null` when the row already agrees with the tree.
 *
 * `permissive` drift is the failure class this gate exists for: the row
 * understates the file (or is missing entirely), so the headroom an author
 * computes from it is larger than the headroom that exists, and the shortfall
 * only surfaces as a ceiling failure *after* the edit is written.
 * `restrictive` drift is the benign mirror — the row overstates the file, so an
 * author under-spends and the ceiling gate is never surprised.
 *
 * @param {{ path: string, bytes: number }} file live file measurement
 * @param {{ bytes?: number, headroomBytes?: number } | undefined} row recorded row
 * @param {number} ceiling
 * @returns {{ path: string, recorded: number|null, actual: number, delta: number,
 *   direction: 'permissive'|'restrictive', recordedHeadroom: number|null,
 *   headroomBytes: number } | null}
 */
function classifyBootRow(file, row, ceiling) {
  const actual = file.bytes;
  const headroomBytes = ceiling - actual;
  const recorded = Number.isFinite(row?.bytes) ? row.bytes : null;
  const recordedHeadroom = Number.isFinite(row?.headroomBytes)
    ? row.headroomBytes
    : recorded === null
      ? null
      : ceiling - recorded;
  // A row is in sync only when both the byte count and the headroom it
  // advertises match the tree — a stale headroom misleads on its own.
  if (recorded === actual && recordedHeadroom === headroomBytes) return null;
  const permissive =
    recorded === null ||
    recorded < actual ||
    (recordedHeadroom !== null && recordedHeadroom > headroomBytes);
  return {
    path: file.path,
    recorded,
    actual,
    delta: recorded === null ? actual : actual - recorded,
    direction: permissive ? 'permissive' : 'restrictive',
    recordedHeadroom,
    headroomBytes,
  };
}

/**
 * Compare every recorded `agentBoot` row against the tree it describes.
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {{ agentBoot?: { ceilingBytes?: number, files?: Array<{ path: string, bytes: number, headroomBytes?: number }> } } | null} baseline
 * @param {number} [ceiling]
 * @returns {Array<ReturnType<typeof classifyBootRow>>} drift rows (empty = in sync)
 */
export function agentBootDrift(tierMap, baseline, ceiling) {
  const recordedCeiling = Number.isFinite(baseline?.agentBoot?.ceilingBytes)
    ? baseline.agentBoot.ceilingBytes
    : AGENT_BOOT_CEILING_BYTES;
  const effective = Number.isFinite(ceiling) ? ceiling : recordedCeiling;
  const rows = new Map(
    (baseline?.agentBoot?.files ?? []).map((f) => [f.path, f]),
  );
  const drift = [];
  for (const file of tierMap?.tiers?.agentBoot ?? []) {
    if (!Number.isFinite(file?.bytes)) continue;
    const row = classifyBootRow(file, rows.get(file.path), effective);
    if (row) drift.push(row);
  }
  return drift;
}

/**
 * Render the agent-boot drift lines. `+` lines are permissive drift (gate
 * fail); `-` lines are restrictive drift (informational). Each line states the
 * **real** remaining headroom, so the author sizing the next edit reads the
 * true number rather than re-deriving it from a row that just proved stale.
 *
 * @param {Array<ReturnType<typeof classifyBootRow>>} drift
 * @returns {string[]}
 */
export function renderBootDrift(drift) {
  return drift.map((d) => {
    const marker = d.direction === 'permissive' ? '+' : '-';
    const recorded =
      d.recorded === null
        ? 'has no recorded row'
        : `records ${d.recorded} bytes but the file is ${d.actual}`;
    const note =
      d.direction === 'permissive'
        ? 'the row overstates the headroom an author would size an edit against'
        : 'the row is conservative — refresh at leisure';
    return `${marker} agentBoot drift: ${d.path} ${recorded} — ${note} (real headroom ${d.headroomBytes})`;
  });
}

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
 * gated tiers are recorded (each as `{ totalBytes, files }`).
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {number} toleranceBytes
 * @returns {object}
 */
export function buildBaseline(tierMap, toleranceBytes) {
  const tiers = {};
  for (const name of GATED_TIERS) {
    const files = tierMap.tiers[name] ?? [];
    tiers[name] = { totalBytes: tierTotalBytes(files), files };
  }
  // The agent-boot tier is recorded top-level (not under `tiers`) because it is
  // gated by a per-file ceiling, not the total-byte ratchet the `tiers` entries
  // use — keeping it out of `tiers` keeps the ratchet diff loop unambiguous.
  // Each row carries the headroom it leaves under the ceiling, so an author
  // sizing an edit reads the remaining budget straight off the row (#4830)
  // instead of re-deriving it — and `agentBootDrift` keeps both numbers honest.
  const agentBootFiles = (tierMap.tiers.agentBoot ?? []).map((f) => ({
    path: f.path,
    bytes: f.bytes,
    headroomBytes: AGENT_BOOT_CEILING_BYTES - f.bytes,
  }));
  return {
    $schema: 'https://mandrel.dev/baselines/context-budget.schema.json',
    generatedAt: new Date().toISOString(),
    toleranceBytes,
    tiers,
    agentBoot: {
      ceilingBytes: AGENT_BOOT_CEILING_BYTES,
      files: agentBootFiles,
    },
    // Recorded, never gated (#4752): the total reachable closure per workflow
    // entry point. It is a drift signal — the gate is `tiers.workflow`.
    workflowClosure: {
      reachableTotalBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
      entryPoints: tierMap.workflowClosure?.entryPoints ?? [],
    },
  };
}

/**
 * Collect the recorded rows of one gated tier that name a path the measured
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
 * gated tier with no current files is skipped; a tier absent from the baseline
 * is skipped. `grown` and `absent` entries fail the gate; `shrunk` entries are
 * reported and written back by the close (Story #5313) — see the ratchet
 * semantics in the module header.
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
  for (const tier of GATED_TIERS) {
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
 * Count the drift entries that fail the gate: growth past tolerance and a
 * recorded row the tree no longer backs. Shrinkage is not in the set (Story
 * #5313 — the close writes it back instead). This is the one place the
 * failure set is defined and both the summary tag and the exit code read it.
 *
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {number}
 */
export function budgetFailureCount(diff) {
  return (diff?.grown?.length ?? 0) + (diff?.absent?.length ?? 0);
}

/**
 * Render the human-readable diff. `+` lines are tiers that grew beyond
 * tolerance; `-` lines are tiers that shrank below their recorded total
 * (informational — the close writes the lower total back) or rows naming a
 * path the tree no longer carries (a gate failure). A one-line summary
 * always follows.
 *
 * @param {ReturnType<typeof diffBudget>} diff
 * @returns {string}
 */
export function renderDiff(diff) {
  const lines = [];
  for (const g of diff.grown) {
    lines.push(
      `+ ${g.tier}: ${g.current} bytes exceeds budget ${g.baseline} + tolerance ${g.tolerance} (delta +${g.delta})`,
    );
  }
  for (const s of diff.shrunk) {
    lines.push(
      `- ${s.tier}: ${s.current} bytes is under the recorded ${s.baseline} (delta -${s.delta}) — the close writes the lower total back to baselines/context-budget.json when this branch lands`,
    );
  }
  for (const a of diff.absent ?? []) {
    lines.push(
      `- ${a.tier}: recorded row ${a.path} names a path the measured tier no longer contains — refresh baselines/context-budget.json`,
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
 *   1 = a gated tier grew beyond tolerance or a recorded row is unbacked
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
      `${JSON.stringify({ kind: 'context-budget-report', baselinePath: resolvedBaselinePath, tiers: tierMap.tiers, grown: [], shrunk: [], absent: [], skipped: GATED_TIERS, exitCode: 0, noBaseline: true }, null, 2)}\n`,
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
 * @returns {{ diff: object, ceiling: number, bootOverflow: object[], bootDrift: object[], permissiveDrift: object[], exitCode: 0 | 1 }}
 */
function evaluateBudget({ tierMap, baseline }) {
  const diff = diffBudget(tierMap, baseline);
  const ceiling = Number.isFinite(baseline?.agentBoot?.ceilingBytes)
    ? baseline.agentBoot.ceilingBytes
    : AGENT_BOOT_CEILING_BYTES;
  const bootOverflow = agentBootOverflow(tierMap, ceiling);
  const bootDrift = agentBootDrift(tierMap, baseline, ceiling);
  const permissiveDrift = bootDrift.filter((d) => d.direction === 'permissive');
  const exitCode =
    budgetFailureCount(diff) > 0 ||
    bootOverflow.length > 0 ||
    permissiveDrift.length > 0
      ? 1
      : 0;
  return { diff, ceiling, bootOverflow, bootDrift, permissiveDrift, exitCode };
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
  const { diff, ceiling, bootOverflow, bootDrift, exitCode } = report;
  const envelope = {
    kind: 'context-budget-report',
    baselinePath: resolvedBaselinePath,
    toleranceBytes: Number.isFinite(baseline.toleranceBytes)
      ? baseline.toleranceBytes
      : 0,
    current: Object.fromEntries(
      GATED_TIERS.map((t) => [t, tierTotalBytes(tierMap.tiers[t] ?? [])]),
    ),
    grown: diff.grown,
    shrunk: diff.shrunk,
    absent: diff.absent,
    skipped: diff.skipped,
    agentBootCeilingBytes: ceiling,
    agentBootOverflow: bootOverflow,
    agentBootDrift: bootDrift,
    workflowReachableBytes: tierMap.workflowClosure?.reachableTotalBytes ?? 0,
    exitCode,
  };
  stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * Each failing condition gets its own remediation line: they are fixed
 * differently (trim a role def vs refresh the budget), so a single generic
 * message would leave the author guessing which applies.
 *
 * @param {object} params
 * @returns {void}
 */
function renderFailureDiagnostics({ report, stderr }) {
  const { diff, ceiling, bootOverflow, permissiveDrift } = report;
  if (permissiveDrift.length > 0) {
    stderr.write(
      `[context-budget] ❌ a recorded agentBoot row understates the file it describes, so it overstates the headroom an author would size an edit against — refresh it with \`node .agents/scripts/check-context-budget.js --update\` (the ceiling is unchanged)\n`,
    );
  }
  if (bootOverflow.length > 0) {
    stderr.write(
      `[context-budget] ❌ a role-agent boot context exceeds the ${ceiling}-byte per-agent ceiling — trim the role def (the ceiling is a hard cap, not a starve target)\n`,
    );
  }
  if (diff.grown.length > 0) {
    stderr.write(
      `[context-budget] ❌ a documentation tier grew beyond tolerance — refresh the budget consciously with \`node .agents/scripts/check-context-budget.js --update\` once the growth is intentional\n`,
    );
  }
  if (diff.absent.length > 0) {
    stderr.write(
      `[context-budget] ❌ a recorded row names a path the measured tier no longer contains — its bytes inflate the recorded total against nothing. Refresh with \`node .agents/scripts/check-context-budget.js --update\`\n`,
    );
  }
}

/**
 * @param {object} params
 * @returns {void}
 */
function renderTextReport({ tierMap, baseline, report, stdout, stderr }) {
  const { diff, bootOverflow, bootDrift, exitCode } = report;
  stdout.write(`\n--- context-budget preview ---\n`);
  stdout.write(`${renderDiff(diff)}\n`);
  const reachable = renderReachable(tierMap, baseline);
  if (reachable) stdout.write(`${reachable}\n`);
  for (const o of bootOverflow) {
    stdout.write(
      `+ agentBoot: ${o.path} is ${o.bytes} bytes, over the ${o.ceiling}-byte per-agent ceiling\n`,
    );
  }
  for (const line of renderBootDrift(bootDrift)) {
    stdout.write(`${line}\n`);
  }
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
