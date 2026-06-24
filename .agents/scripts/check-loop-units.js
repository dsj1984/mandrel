/**
 * CLI: loop-unit lint gate (Story #4288, Epic #4284).
 *
 * Validates every loop-unit markdown file under `.agents/workflows/loops/`
 * against `.agents/schemas/loop-unit.schema.json` via
 * `lib/loop-units/validate-loop-unit.js`. An absent or empty loops
 * directory is a **clean pass** (exit 0) — the gate only fails when a unit
 * file is present and invalid.
 *
 * On any invalid (or structurally unparseable) unit the CLI prints a
 * message naming the offending file and the missing/invalid field, then
 * exits non-zero. This is wired into `npm run lint` so a malformed loop
 * unit fails the lint gate.
 *
 * Flags:
 *   --dir <path>  override the loops directory (default
 *                 `.agents/workflows/loops`, resolved from cwd)
 *   --json        write a structured envelope to stdout instead of the
 *                 human-readable preview
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import {
  LoopUnitParseError,
  validateLoopUnit,
} from './lib/loop-units/validate-loop-unit.js';

export const DEFAULT_LOOPS_DIR = path.join('.agents', 'workflows', 'loops');

/**
 * Parse argv for `--dir <path>` and `--json`. Exported so tests can pin
 * the parser.
 *
 * @param {string[]} argv
 * @returns {{ dir: string | null, json: boolean }}
 */
export function parseArgv(argv = []) {
  let dir = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        dir = next;
        i += 1;
      }
    } else if (a === '--json') {
      json = true;
    }
  }
  return { dir, json };
}

/**
 * `README.md` (any case) under the loops directory is namespace
 * documentation, not a loop unit — it carries no `loop:` frontmatter and is
 * not projected as a `/loops:` command (see `sync-claude-commands.js`). It is
 * excluded from the loop-unit collector so the lint gate never flags the
 * directory's own README as a malformed unit.
 *
 * @param {string} name a directory-entry basename
 * @returns {boolean}
 */
export function isLoopUnitFile(name) {
  return name.endsWith('.md') && name.toLowerCase() !== 'readme.md';
}

/**
 * Collect `*.md` loop-unit files directly under `dir`, sorted. Returns an
 * empty array when the directory is absent (the clean-pass case). The
 * directory's `README.md` is excluded — it is namespace documentation, not a
 * unit (see `isLoopUnitFile`).
 *
 * @param {string} dir absolute path
 * @returns {string[]} absolute paths
 */
export function collectLoopUnitFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && isLoopUnitFile(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Validate every loop unit under `dir`. Returns the per-file results and a
 * roll-up `failures` array carrying `{ file, issues }` for each invalid or
 * unparseable unit.
 *
 * @param {string} dir absolute path
 * @param {{ schemaPath?: string }} [opts]
 * @returns {{ files: string[], failures: Array<{ file: string, issues: Array<{path:string,message:string}> }> }}
 */
export function checkLoopUnits(dir, opts = {}) {
  const files = collectLoopUnitFiles(dir);
  const failures = [];
  for (const file of files) {
    try {
      const { valid, issues } = validateLoopUnit(file, opts);
      if (!valid) failures.push({ file, issues });
    } catch (err) {
      if (err instanceof LoopUnitParseError) {
        failures.push({ file, issues: [{ path: '/', message: err.reason }] });
      } else {
        throw err;
      }
    }
  }
  return { files, failures };
}

/**
 * Render the human-readable report. Each failure lists the offending file
 * and one line per issue naming the field path and message.
 *
 * @param {{ files: string[], failures: Array<{ file: string, issues: Array<{path:string,message:string}> }> }} result
 * @returns {string}
 */
export function renderReport({ files, failures }) {
  const lines = [];
  if (files.length === 0) {
    lines.push('[check-loop-units] no loop units found (ok)');
    return lines.join('\n');
  }
  for (const { file, issues } of failures) {
    lines.push(`✖ ${file}`);
    for (const issue of issues) {
      lines.push(`    ${issue.path}: ${issue.message}`);
    }
  }
  const tag = failures.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[check-loop-units] checked=${files.length} invalid=${failures.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * Top-level CLI entry. Exported so tests can drive the full pipeline
 * against a tmpdir fixture directory.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} 0 = clean; 1 = at least one invalid unit
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { dir, json } = parseArgv(argv);
  const loopsDir = path.resolve(cwd, dir ?? DEFAULT_LOOPS_DIR);
  const result = checkLoopUnits(loopsDir);
  const exitCode = result.failures.length > 0 ? 1 : 0;

  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          kind: 'loop-units-report',
          dir: loopsDir,
          checked: result.files.length,
          failures: result.failures,
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const report = renderReport(result);
    if (exitCode === 0) {
      stdout.write(`${report}\n`);
    } else {
      stderr.write(`${report}\n`);
    }
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'check-loop-units',
  propagateExitCode: true,
  errorPrefix: '[check-loop-units] ❌ Fatal error',
});
