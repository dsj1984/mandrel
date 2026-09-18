/**
 * CLI: provenance-citation **report** for workflow prose.
 *
 * Workflow documents ride resident in an executing agent's context. A
 * `(Story #1234)` aside costs the same tokens as instruction and teaches
 * the model Mandrel's own history instead of the task in front of it. The
 * citations that survive are the ones a reader must follow to act; the
 * rest belong in the commit trail and `docs/decisions.md`.
 *
 * This command counts every issue-shaped reference across
 * `.agents/workflows/**\/*.md` and prints the per-file tally. It **always
 * exits 0**: Story #5340 demoted it from a ratchet to a report and deleted
 * `baselines/workflow-citations.json` with it. The ratchet failed a rise
 * above a committed total, so a prose fix that added one pointer had to be
 * paid for with an unrelated trim in the same commit — and that is how three
 * reference sections came to describe mechanisms the code had already
 * retired. The count is still worth seeing on every change, so it stays a
 * report. See `docs/decisions.md`, ADR 20260917-5340.
 *
 * The counted token is the bare `#NNNN` form rather than the
 * `(Story|Epic|issue|refs) #NNNN` phrasing, because the same citation is
 * written both ways — `(Story #4593)` and a bare `(#4593)` — and a report
 * that only saw the prefixed form would undercount the other one.
 *
 * Flags:
 *   --root <path>      scan a different workflow root (default
 *                      `.agents/workflows`)
 *   --json             write the structured envelope to stdout
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';

/** Default workflow root, relative to the repository root. */
const DEFAULT_ROOT = path.join('.agents', 'workflows');

/**
 * Issue-shaped reference: a `#` followed by 3–5 digits. Narrow enough to
 * skip markdown headings and anchor links, wide enough to catch both the
 * `(Story #1234)` and bare `(#1234)` spellings of one citation.
 */
const CITATION_RE = /#\d{3,5}\b/g;

/**
 * Parse argv. Exported so unit tests can pin the parser.
 *
 * @param {string[]} argv
 * @returns {{ rootPath: string | null, json: boolean }}
 */
export function parseArgv(argv = []) {
  const out = { rootPath: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--root' && next && !next.startsWith('--')) {
      out.rootPath = next;
      i += 1;
    } else if (flag === '--json') {
      out.json = true;
    }
  }
  return out;
}

/**
 * Recursively collect `.md` files under `rootDir`. Returns absolute paths,
 * sorted for determinism.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function collectMarkdownFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(rootDir);
  return out.sort();
}

/**
 * Pure helper: count citations in source text.
 *
 * @param {string} source
 * @returns {number}
 */
export function countCitations(source) {
  return (String(source ?? '').match(CITATION_RE) ?? []).length;
}

/**
 * Count citations across a file set, relativizing paths against `cwd` so
 * the report serializes identically on every platform. Files with zero
 * citations are omitted — the report names where the tax lives.
 *
 * @param {string[]} files absolute paths
 * @param {string} cwd
 * @param {{ readFile?: (p: string) => string }} [opts]
 * @returns {{ total: number, files: Array<{ path: string, count: number }> }}
 */
export function tallyCitations(files, cwd, { readFile } = {}) {
  const read = readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const rows = [];
  let total = 0;
  for (const file of files) {
    let count;
    try {
      count = countCitations(read(file));
    } catch {
      continue;
    }
    if (count === 0) continue;
    total += count;
    rows.push({
      path: path.relative(cwd, file).split(path.sep).join('/'),
      count,
    });
  }
  return { total, files: rows.sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Pure helper: render the human-readable report — one line per file that
 * carries a citation, then the total. No `+` / `-` ratchet vocabulary: there
 * is nothing to regress against.
 *
 * @param {{ total: number, files: Array<{ path: string, count: number }> }} tally
 * @returns {string}
 */
export function renderReport(tally) {
  const lines = tally.files.map((row) => `  ${row.path}: ${row.count}`);
  lines.push(
    `[workflow-citations] total=${tally.total} across ${tally.files.length} file(s) — report only, never gated`,
  );
  return lines.join('\n');
}

/**
 * Top-level CLI entry. Exported so tests can drive the pipeline against a
 * tmpdir fixture corpus.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} always 0 — this is a report, not a gate
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const { rootPath, json } = parseArgv(argv);
  const root = path.resolve(cwd, rootPath ?? DEFAULT_ROOT);
  if (!fs.existsSync(root)) {
    throw new Error(`[workflow-citations] workflow root not found: ${root}`);
  }

  const tally = tallyCitations(collectMarkdownFiles(root), cwd);

  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          kind: 'workflow-citations-report',
          root,
          total: tally.total,
          files: tally.files,
          exitCode: 0,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  stdout.write(`\n--- workflow-citations report ---\n`);
  stdout.write(`${renderReport(tally)}\n`);
  return 0;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'workflow-citations',
  propagateExitCode: true,
  errorPrefix: '[workflow-citations] ❌ Fatal error',
  usage: {
    invocation:
      'node scripts/check-workflow-citations.js [--root <dir>] [--json]',
    summary:
      'Report provenance citations in workflow prose: count issue-shaped references across .agents/workflows/** and print the per-file tally. Never fails.',
    flags: [
      ['--root <dir>', 'Workflow root to scan (default: .agents/workflows).'],
      ['--json', 'Emit the report envelope as JSON.'],
    ],
    notes: [
      'Exit codes:\n  0  always — this is a report, not a gate (Story #5340)',
    ],
  },
});
