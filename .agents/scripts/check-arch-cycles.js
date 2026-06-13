/**
 * CLI: ratchet-down architecture gate for import cycles (Story #3991).
 *
 * Walks every `.js` file across the project's **distributed surface**
 * (the `files[]` set published to npm — `.agents/scripts/`, `bin/`, and
 * the root `lib/`, excluding `node_modules`), parses relative
 * static-import edges (`from './…/x.js'`), detects directed cycles via
 * DFS, and compares them against the committed allowlist at
 * `baselines/arch-cycles.json`.
 *
 * The multi-root scan resolves every root into a **single** import graph
 * keyed by repository-relative module ids (Story #4071). This lets
 * `findCycles` catch cycles that cross the documented lifecycle↔runtime
 * partition — e.g. a `bin/` lifecycle script and an `.agents/scripts/lib`
 * runtime module importing each other — which a single-root scan cannot
 * see because it only walks one side of the partition.
 *
 * Ratchet semantics mirror `check-dead-exports.js`:
 *   - Any detected cycle NOT in the allowlist → exit 1, cycle path printed.
 *   - Allowlisted cycle no longer detected → printed as `-` (removal),
 *     warning that the allowlist can shrink. Removals-only exits 0.
 *   - Clean diff → exit 0.
 *
 * Cycles are normalized by rotating to the lexicographically-smallest
 * member so the same cycle always serializes identically regardless of
 * the DFS entry point.
 *
 * Flags:
 *   --baseline <path>  override the allowlist path (default
 *                      `baselines/arch-cycles.json`, resolved from cwd)
 *   --root <path>      scan a single explicit root instead of the default
 *                      distributed surface, relativized against that root
 *   --json             write the structured envelope to stdout
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';

/**
 * Default scan roots making up the project's distributed surface — the
 * directories published to npm via `package.json` `files[]`. Resolving
 * them into one graph (relativized against the repo root) means a cycle
 * crossing two roots is visible to `findCycles`.
 *
 * @type {string[]}
 */
export const DEFAULT_ROOTS = [path.join('.agents', 'scripts'), 'bin', 'lib'];

/**
 * Parse argv for `--baseline <path>`, `--root <path>`, and `--json`.
 * Exported so unit tests can pin the parser.
 *
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
 * Recursively collect `.js` files under `rootDir`, skipping
 * `node_modules`. Returns absolute paths, sorted for determinism.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function collectJsFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

const IMPORT_RE = /from\s+['"](\.\.?\/[^'"]+\.js)['"]/g;

/**
 * Pure helper: extract relative static-import specifiers from source text.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseRelativeImports(source) {
  const specs = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    specs.push(m[1]);
  }
  return specs;
}

/**
 * Build a directed import graph over the given files. Node identity is the
 * file path relative to `rootDir`, posix-separated, so the graph (and any
 * cycles found in it) serializes identically across platforms. Edges that
 * resolve outside the scanned file set are dropped.
 *
 * @param {string[]} files absolute paths
 * @param {string} rootDir
 * @param {{ readFile?: (p: string) => string }} [opts]
 * @returns {Map<string, string[]>}
 */
export function buildGraph(files, rootDir, { readFile } = {}) {
  const read = readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const toId = (abs) => path.relative(rootDir, abs).split(path.sep).join('/');
  const idSet = new Set(files.map(toId));
  const graph = new Map();
  for (const file of files) {
    const id = toId(file);
    let source;
    try {
      source = read(file);
    } catch {
      graph.set(id, []);
      continue;
    }
    const edges = [];
    for (const spec of parseRelativeImports(source)) {
      const target = path
        .relative(rootDir, path.resolve(path.dirname(file), spec))
        .split(path.sep)
        .join('/');
      if (idSet.has(target) && target !== id) edges.push(target);
    }
    graph.set(id, [...new Set(edges)].sort());
  }
  return graph;
}

/**
 * Pure helper: rotate a cycle (array of module ids, no repeated terminal
 * element) so it starts at its lexicographically-smallest member. The same
 * cycle therefore always serializes identically regardless of where the
 * DFS entered it.
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
 * Detect directed cycles in the graph via iterative-stack DFS (white /
 * gray / black coloring). Each back edge to a gray node yields the cycle
 * slice currently on the DFS path. Cycles are normalized and deduplicated
 * by their serialized form, then sorted for stable output.
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
 * Pure helper: read the allowlist envelope from disk. Returns the parsed
 * object or `null` when the file is missing or unparseable.
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
 * Pure helper: diff detected cycles against the allowlist. Both sides are
 * normalized before comparison so rotation differences never count as
 * drift. Identity is the ` -> `-joined normalized cycle.
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
 * Pure helper: render the human-readable diff. `+` lines are new cycles
 * (gate fail), `-` lines are fixed cycles whose allowlist entry can be
 * removed. A one-line summary always follows.
 *
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
 * Top-level CLI entry. Exported so tests can drive the full pipeline
 * against a tmpdir fixture graph.
 *
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
  // With an explicit `--root`, scan that single root and relativize ids
  // against it (unchanged contract). Without it, scan the full distributed
  // surface and relativize every id against the repo root (`cwd`) so edges
  // that cross two roots resolve into a single graph.
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
});
