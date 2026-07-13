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
 *
 * It additionally enforces a **per-file** ceiling on the role-scoped agent-boot
 * tier (`.agents/agents/*.md`, #4478): no single boot context may exceed
 * `agentBoot.ceilingBytes` (default 8192). This is a per-agent cap, not a sum
 * ratchet — each role def is a standalone system prompt a converted spawn boots
 * on, and adding another role def is legitimate.
 *
 * A read-tier that resolves **empty** is skipped silently (the `docsContextFiles`
 * half skips when unconfigured / its files are absent), so a repo with no
 * `CLAUDE.md` and no context docs is a clean no-op.
 *
 * Ratchet semantics (mirroring the sibling ratchets):
 *   - A gated tier grows beyond `baseline.tiers.<tier>.totalBytes +
 *     baseline.toleranceBytes` → exit 1, naming the tier and its delta.
 *   - A gated tier shrinks below its baseline total → printed as a `-`
 *     (removal) note, warning the baseline can be refreshed downward.
 *     Shrink-only exits 0.
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
 * The tiers this ratchet gates (in report order). `digestVisible` and
 * `onDemand` are resolved by the tier map for the lens, but the byte budget
 * intentionally gates only the two tiers the Epic AC names.
 * @type {Array<'alwaysLoaded' | 'mandatoryRead'>}
 */
export const GATED_TIERS = ['alwaysLoaded', 'mandatoryRead'];

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
  const agentBootFiles = tierMap.tiers.agentBoot ?? [];
  return {
    $schema: 'https://mandrel.dev/baselines/context-budget.schema.json',
    generatedAt: new Date().toISOString(),
    toleranceBytes,
    tiers,
    agentBoot: {
      ceilingBytes: AGENT_BOOT_CEILING_BYTES,
      files: agentBootFiles,
    },
  };
}

/**
 * Pure diff: compare the current tier map against the committed baseline. A
 * gated tier with no current files is skipped; a tier absent from the baseline
 * is skipped. `grown` entries fail the gate; `shrunk` entries are informational.
 *
 * @param {{ tiers: Record<string, Array<{ path: string, bytes: number }>> }} tierMap
 * @param {{ toleranceBytes?: number, tiers?: Record<string, { totalBytes: number }> }} baseline
 * @returns {{
 *   grown: Array<{ tier: string, current: number, baseline: number, tolerance: number, delta: number }>,
 *   shrunk: Array<{ tier: string, current: number, baseline: number }>,
 *   skipped: string[],
 * }}
 */
export function diffBudget(tierMap, baseline) {
  const tolerance = Number.isFinite(baseline?.toleranceBytes)
    ? baseline.toleranceBytes
    : 0;
  const grown = [];
  const shrunk = [];
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
      shrunk.push({ tier, current, baseline: baselineBytes });
    }
  }
  return { grown, shrunk, skipped };
}

/**
 * Render the human-readable diff. `+` lines are tiers that grew beyond
 * tolerance (gate fail); `-` lines are tiers that shrank (refreshable
 * baseline). A one-line summary always follows.
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
      `- ${s.tier}: ${s.current} bytes below baseline ${s.baseline} — refresh baselines/context-budget.json`,
    );
  }
  const tag = diff.grown.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[context-budget] grown=${diff.grown.length} shrunk=${diff.shrunk.length} skipped=${diff.skipped.length} ${tag}`,
  );
  return lines.join('\n');
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
 *   1 = a gated tier grew beyond tolerance
 */
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

  const baseline = loadBaseline(resolvedBaselinePath);
  if (!baseline) {
    if (json) {
      stdout.write(
        `${JSON.stringify({ kind: 'context-budget-report', baselinePath: resolvedBaselinePath, tiers: tierMap.tiers, grown: [], shrunk: [], skipped: GATED_TIERS, exitCode: 0, noBaseline: true }, null, 2)}\n`,
      );
    } else {
      stderr.write(
        `[context-budget] ⚠ budget not found at ${resolvedBaselinePath} — skipping (no-op)\n`,
      );
    }
    return 0;
  }

  const diff = diffBudget(tierMap, baseline);
  const ceiling = Number.isFinite(baseline?.agentBoot?.ceilingBytes)
    ? baseline.agentBoot.ceilingBytes
    : AGENT_BOOT_CEILING_BYTES;
  const bootOverflow = agentBootOverflow(tierMap, ceiling);
  const exitCode = diff.grown.length > 0 || bootOverflow.length > 0 ? 1 : 0;

  if (json) {
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
      skipped: diff.skipped,
      agentBootCeilingBytes: ceiling,
      agentBootOverflow: bootOverflow,
      exitCode,
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    stdout.write(`\n--- context-budget preview ---\n`);
    stdout.write(`${renderDiff(diff)}\n`);
    for (const o of bootOverflow) {
      stdout.write(
        `+ agentBoot: ${o.path} is ${o.bytes} bytes, over the ${o.ceiling}-byte per-agent ceiling\n`,
      );
    }
    if (exitCode === 1) {
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
    }
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'context-budget',
  propagateExitCode: true,
  errorPrefix: '[context-budget] ❌ Fatal error',
});
