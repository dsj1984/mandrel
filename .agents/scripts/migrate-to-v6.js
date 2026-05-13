#!/usr/bin/env node

/**
 * .agents/scripts/migrate-to-v6.js
 *
 * One-command consumer migration tool: rewrites `.agentrc.json` legacy
 * keys (via [`lib/v5-to-v6-keymap.js`](./lib/v5-to-v6-keymap.js)),
 * updates the `.gitmodules` URL for the `.agents/` submodule
 * (`agent-protocols` → `mandrel`), and bumps `package.json` peerDep
 * (or any other dependency block) that references the legacy package
 * name. Idempotent; safe to re-run.
 *
 * Acceptance (Task #1624):
 *   - Running on a v5 fixture leaves it on v6 with no manual residue.
 *   - Running twice on the same fixture produces no diff on the second
 *     run.
 *   - Running on a dirty working tree exits non-zero without `--yes`;
 *     with `--yes`, proceeds with a logged confirmation.
 *   - Tool makes zero network calls.
 *
 * Design notes:
 *   - The CLI is a thin filesystem + `git status` wrapper around the
 *     pure functions in [`./lib/migrate-to-v6-core.js`](./lib/migrate-to-v6-core.js).
 *     The split keeps tests deterministic (the test passes fixture
 *     objects through `runMigration({...})` and ignores the I/O seam).
 *   - All paths are resolved relative to `--cwd` (default `process.cwd()`)
 *     so the script never reads or writes outside the consumer's repo
 *     root.
 *   - No network: no `fetch`, no `https`, no `child_process` spawn other
 *     than the single `git status --porcelain` check for dirty trees.
 *     `git` is invoked via `node:child_process` `spawnSync` — a local
 *     binary, not a network call.
 *   - When invoked with `--dry-run`, the CLI computes the migration plan
 *     and prints the summary but writes nothing. Useful as a preview.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { planMigration } from './lib/migrate-to-v6-core.js';

const AGENTRC_FILENAME = '.agentrc.json';
const GITMODULES_FILENAME = '.gitmodules';
const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * Read a JSON file or return `null` if it does not exist. Throws on
 * parse failure — a malformed `.agentrc.json` is a hard error, not a
 * silent skip, because the next push would fail validation anyway.
 *
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON at ${path}: ${detail}`);
  }
}

/**
 * Read a text file or return `null` if it does not exist.
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/**
 * Detect whether the working tree at `cwd` is dirty. We use
 * `git status --porcelain` because it exits 0 even on a non-repo (with
 * empty output) when stderr is captured; we treat exit 128 (not a
 * repo) as `{ isRepo: false, dirty: false }` so a consumer migrating
 * a freshly-cloned tree with no `.git/` still works.
 *
 * @param {string} cwd
 * @returns {{ isRepo: boolean; dirty: boolean; rawStdout: string }}
 */
export function checkWorkingTree(cwd) {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    // Hard timeout to defend against an unbounded hang on a corrupt
    // repository — local op, should always return in ms.
    timeout: 15000,
  });
  if (result.error || result.status === 128) {
    return { isRepo: false, dirty: false, rawStdout: '' };
  }
  if (result.status !== 0) {
    // Unexpected non-zero — treat as dirty to fail safe.
    return { isRepo: true, dirty: true, rawStdout: result.stdout ?? '' };
  }
  const stdout = result.stdout ?? '';
  return { isRepo: true, dirty: stdout.trim().length > 0, rawStdout: stdout };
}

/** @param {{ action: 'rename' | 'remove'; from: string; to: string | null; removedIn?: string }} change */
function formatAgentrcChange(change) {
  if (change.action === 'rename') {
    return `  rename  ${change.from}  →  ${change.to}`;
  }
  const since = change.removedIn ? ` (removed in ${change.removedIn})` : '';
  return `  remove  ${change.from}${since}`;
}

/** @param {ReturnType<typeof planMigration>['agentrc']} agentrc */
function agentrcSection(agentrc) {
  if (agentrc === null || agentrc.changes.length === 0) return [];
  return ['', '.agentrc.json:', ...agentrc.changes.map(formatAgentrcChange)];
}

/** @param {ReturnType<typeof planMigration>['gitmodules']} gitmodules */
function gitmodulesSection(gitmodules) {
  if (gitmodules === null || !gitmodules.changed) return [];
  return ['', '.gitmodules: rewrote agent-protocols → mandrel URL'];
}

/** @param {ReturnType<typeof planMigration>['packageJson']} packageJson */
function packageJsonSection(packageJson) {
  if (packageJson === null || packageJson.changes.length === 0) return [];
  const rows = packageJson.changes.map(
    (c) => `  ${c.section}: ${c.from} → ${c.to} (range preserved: ${c.range})`,
  );
  return ['', 'package.json:', ...rows];
}

/**
 * Render a plain-text summary of the migration plan for stdout. Kept
 * separate from `runMigration` so tests can assert against the
 * structured envelope while operators get readable output. Composes the
 * three per-file section helpers above — each returns an empty array
 * when its slice is a no-op, so `formatSummary` itself stays a simple
 * fan-out + join.
 *
 * @param {ReturnType<typeof planMigration>} plan
 * @returns {string}
 */
export function formatSummary(plan) {
  if (plan.summary.alreadyV6) {
    return [
      '--- migrate-to-v6 summary ---',
      'No legacy v5 keys found. Already on v6 — nothing to do.',
    ].join('\n');
  }
  return [
    '--- migrate-to-v6 summary ---',
    ...agentrcSection(plan.agentrc),
    ...gitmodulesSection(plan.gitmodules),
    ...packageJsonSection(plan.packageJson),
    '',
    `Total changes: ${plan.summary.totalChanges}. Re-run to confirm no further changes (idempotency check).`,
  ].join('\n');
}

/**
 * High-level runner used by both the CLI and the test suite. Reads
 * the three input files (when present), builds the plan, and — unless
 * `dryRun` — writes the rewritten content back. Returns the structured
 * envelope so callers can assert on it.
 *
 * @param {{ cwd: string; dryRun?: boolean; yes?: boolean }} options
 * @returns {{ ok: boolean; reason?: string; plan: ReturnType<typeof planMigration>; written: string[] }}
 */
export function runMigration({ cwd, dryRun = false, yes = false }) {
  const tree = checkWorkingTree(cwd);
  if (tree.isRepo && tree.dirty && !yes) {
    return {
      ok: false,
      reason:
        'Working tree is dirty. Commit or stash your changes first, or re-run with --yes to override.',
      plan: planMigration({
        agentrc: null,
        gitmodules: null,
        packageJson: null,
      }),
      written: [],
    };
  }

  const agentrcPath = resolvePath(cwd, AGENTRC_FILENAME);
  const gitmodulesPath = resolvePath(cwd, GITMODULES_FILENAME);
  const packageJsonPath = resolvePath(cwd, PACKAGE_JSON_FILENAME);

  const agentrc = readJsonOrNull(agentrcPath);
  const gitmodules = readTextOrNull(gitmodulesPath);
  const packageJson = readJsonOrNull(packageJsonPath);

  const plan = planMigration({ agentrc, gitmodules, packageJson });
  /** @type {string[]} */
  const written = [];

  if (dryRun) {
    return { ok: true, plan, written };
  }

  if (
    plan.agentrc !== null &&
    plan.agentrc.changes.length > 0 &&
    agentrc !== null
  ) {
    writeFileSync(
      agentrcPath,
      `${JSON.stringify(plan.agentrc.next, null, 2)}\n`,
      'utf8',
    );
    written.push(AGENTRC_FILENAME);
  }
  if (plan.gitmodules !== null && plan.gitmodules.changed) {
    writeFileSync(gitmodulesPath, plan.gitmodules.next, 'utf8');
    written.push(GITMODULES_FILENAME);
  }
  if (
    plan.packageJson !== null &&
    plan.packageJson.changed &&
    packageJson !== null
  ) {
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(plan.packageJson.next, null, 2)}\n`,
      'utf8',
    );
    written.push(PACKAGE_JSON_FILENAME);
  }

  return { ok: true, plan, written };
}

/**
 * Parse CLI arguments via the canonical `defineFlags` helper from
 * `lib/cli-args.js`. Exported for test reuse under the project-standard
 * name `parseArgv` (the `parseCliArgs` walker pattern is forbidden by
 * `tests/enforcement/parse-cli-args.test.js`).
 *
 * @param {string[]} argv
 */
export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      cwd: { type: 'string', alias: 'cwd' },
      'dry-run': { type: 'boolean', alias: 'dryRun' },
      yes: { type: 'boolean', alias: 'yes', short: 'y' },
      help: { type: 'boolean', alias: 'help', short: 'h' },
    },
    argv,
  );
  return {
    cwd:
      typeof values.cwd === 'string' && values.cwd.length > 0
        ? values.cwd
        : process.cwd(),
    dryRun: values.dryRun === true,
    yes: values.yes === true,
    help: values.help === true,
  };
}

const HELP_TEXT = `Usage: node .agents/scripts/migrate-to-v6.js [options]

Rewrites a consumer's v5.x agent-protocols configuration to v6 (mandrel).

Options:
  --cwd <path>   Target repo root. Defaults to the current directory.
  --dry-run      Compute the migration plan and print it; write nothing.
  --yes, -y      Proceed even if the working tree is dirty (with caution).
  --help, -h     Show this message.

Files touched (when present at the repo root):
  .agentrc.json   — legacy keys rewritten / removed per the v5→v6 keymap
  .gitmodules     — agent-protocols → mandrel URL bump
  package.json    — dependency / peerDep entries renamed (version preserved)

Exits 0 when the migration completes (including on an already-v6 repo).
Exits non-zero on a dirty working tree without --yes, or on any I/O error.

The tool makes zero network calls and never writes outside the repo root.
Re-run after the first pass to confirm idempotency: the second run should
report zero changes.`;

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  const result = runMigration({
    cwd: args.cwd,
    dryRun: args.dryRun,
    yes: args.yes,
  });
  if (!result.ok) {
    process.stderr.write(`migrate-to-v6: ${result.reason}\n`);
    return 2;
  }
  process.stdout.write(`${formatSummary(result.plan)}\n`);
  if (args.dryRun) {
    process.stdout.write(
      '\n(dry-run: no files written. Re-run without --dry-run to apply.)\n',
    );
  } else if (result.written.length > 0) {
    process.stdout.write(`\nWrote: ${result.written.join(', ')}\n`);
  }
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'migrate-to-v6',
  propagateExitCode: true,
});
