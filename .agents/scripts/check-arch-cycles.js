/**
 * CLI: ratchet-down gate for relative static-import cycles across the npm
 * distributed surface, against the allowlist `baselines/arch-cycles.json`.
 * All roots resolve into ONE graph keyed by repo-relative ids, so a cycle
 * crossing the `bin/` ↔ `.agents/scripts/lib` partition is visible. Exit 1
 * only on a new cycle; a vanished allowlisted cycle is reported as `-`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import {
  buildGraph,
  collectJsFiles,
  DEFAULT_ROOTS,
  parseRelativeImports,
} from './lib/import-graph.js';

// Shared with `audit-baselines.js`; re-exported as part of this module's contract.
export { buildGraph, collectJsFiles, DEFAULT_ROOTS, parseRelativeImports };

/**
 * @param {string[]} argv
 * @returns {{ baselinePath: string | null, rootPath: string | null, json: boolean }}
 */
export function parseArgv(argv = []) {
  let baselinePath = null;
  let rootPath = null;
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
    } else if (a === '--json') {
      json = true;
    }
  }
  return { baselinePath, rootPath, json };
}

/**
 * Rotate a cycle to start at its smallest member, so it serializes the same
 * whatever the DFS entry point.
 *
 * @param {string[]} cycle
 * @returns {string[]}
 */
export function normalizeCycle(cycle) {
  if (cycle.length === 0) return [];
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i += 1) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/**
 * Iterative three-colour DFS; each back edge to a gray node yields the path
 * slice as a cycle. Normalized, deduplicated, sorted.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[][]} normalized cycles
 */
export function findCycles(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const node of graph.keys()) color.set(node, WHITE);
  const seen = new Map();

  const pathStack = [];
  const onPath = new Map(); // node -> index in pathStack

  const visit = (start) => {
    // Iterative DFS frame stack: [node, edge cursor].
    const frames = [[start, 0]];
    color.set(start, GRAY);
    onPath.set(start, pathStack.length);
    pathStack.push(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [node] = frame;
      const edges = graph.get(node) ?? [];
      if (frame[1] < edges.length) {
        const next = edges[frame[1]];
        frame[1] += 1;
        const c = color.get(next);
        if (c === GRAY) {
          const cycle = normalizeCycle(pathStack.slice(onPath.get(next)));
          seen.set(cycle.join(' -> '), cycle);
        } else if (c === WHITE) {
          color.set(next, GRAY);
          onPath.set(next, pathStack.length);
          pathStack.push(next);
          frames.push([next, 0]);
        }
      } else {
        color.set(node, BLACK);
        onPath.delete(node);
        pathStack.pop();
        frames.pop();
      }
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (color.get(node) === WHITE) visit(node);
  }
  return [...seen.values()].sort((a, b) =>
    a.join(' -> ').localeCompare(b.join(' -> ')),
  );
}

/**
 * `null` when missing or unparseable.
 *
 * @param {string} baselinePath
 * @returns {{ cycles?: string[][] } | null}
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
 * Both sides normalized, so a rotation never counts as drift.
 *
 * @param {string[][]} allowlisted
 * @param {string[][]} detected
 * @returns {{ added: string[][], removed: string[][] }}
 */
export function diffCycles(allowlisted, detected) {
  const key = (c) => normalizeCycle(c).join(' -> ');
  const baseSet = new Set((allowlisted ?? []).map(key));
  const currentSet = new Set((detected ?? []).map(key));
  const added = (detected ?? []).filter((c) => !baseSet.has(key(c)));
  const removed = (allowlisted ?? []).filter((c) => !currentSet.has(key(c)));
  const sortFn = (a, b) => key(a).localeCompare(key(b));
  return { added: added.sort(sortFn), removed: removed.sort(sortFn) };
}

/**
 * @param {{ added: string[][], removed: string[][] }} diff
 * @returns {string}
 */
export function renderDiff(diff) {
  const lines = [];
  const fmt = (c) => `${c.join(' -> ')} -> ${c[0]}`;
  for (const c of diff.added) lines.push(`+ ${fmt(c)}`);
  for (const c of diff.removed) lines.push(`- ${fmt(c)}`);
  if (diff.removed.length > 0) {
    lines.push(
      `[arch-cycles] ⚠ ${diff.removed.length} allowlisted cycle(s) no longer detected — shrink baselines/arch-cycles.json`,
    );
  }
  const tag = diff.added.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[arch-cycles] added=${diff.added.length} removed=${diff.removed.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} 0 = clean or removals-only; 1 = new cycle detected
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { baselinePath, rootPath, json } = parseArgv(argv);
  // `--root` scans one root relative to itself; otherwise every root is
  // relativized against `cwd` so cross-root edges join one graph.
  const graphRoot = rootPath ? path.resolve(cwd, rootPath) : path.resolve(cwd);
  const scanDirs = (rootPath ? [rootPath] : DEFAULT_ROOTS).map((dir) =>
    path.resolve(cwd, dir),
  );
  const resolvedBaselinePath = path.resolve(
    cwd,
    baselinePath ?? path.join('baselines', 'arch-cycles.json'),
  );
  const presentScanDirs = scanDirs.filter((dir) => fs.existsSync(dir));
  if (presentScanDirs.length === 0) {
    throw new Error(`[arch-cycles] no scan root found: ${scanDirs.join(', ')}`);
  }
  const baseline = loadBaseline(resolvedBaselinePath);
  const allowlisted = Array.isArray(baseline?.cycles) ? baseline.cycles : [];

  const files = presentScanDirs.flatMap((dir) => collectJsFiles(dir));
  const graph = buildGraph(files, graphRoot);
  const detected = findCycles(graph);
  const diff = diffCycles(allowlisted, detected);
  const exitCode = diff.added.length > 0 ? 1 : 0;

  if (json) {
    const envelope = {
      kind: 'arch-cycles-report',
      root: graphRoot,
      baselinePath: resolvedBaselinePath,
      allowlisted: allowlisted.map(normalizeCycle),
      detected,
      added: diff.added,
      removed: diff.removed,
      exitCode,
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    if (!baseline) {
      stderr.write(
        `[arch-cycles] ⚠ allowlist not found at ${resolvedBaselinePath} — treating as empty\n`,
      );
    }
    stdout.write(`\n--- arch-cycles preview ---\n`);
    stdout.write(`${renderDiff(diff)}\n`);
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'arch-cycles',
  propagateExitCode: true,
  errorPrefix: '[arch-cycles] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/check-arch-cycles.js [--baseline <path>] [--root <dir>] [--json]',
    summary:
      'Ratchet on module-dependency cycles: compare the live import graph against the recorded baseline and fail on any newly added cycle.',
    flags: [
      [
        '--baseline <path>',
        'Baseline file (default: baselines/arch-cycles.json).',
      ],
      [
        '--root <dir>',
        'Scan a single root instead of the distributed surface.',
      ],
      ['--json', 'Emit the comparison envelope as JSON.'],
    ],
    notes: [
      'Exit codes:\n  0  clean, or removals only\n  1  a new cycle was detected',
    ],
  },
});
