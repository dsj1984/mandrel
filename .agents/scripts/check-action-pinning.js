/**
 * CLI: third-party GitHub Action pinning gate.
 *
 * Story #4079 (audit::devops). Closes a supply-chain regression window the
 * `ci.yml` / `release-please.yml` comments *claimed* was guarded by a
 * nonexistent `npm run audit-security` gate. There is no such npm script;
 * `audit-security` is only a manual `/audit-security` slash-command lens.
 * Nothing actually enforced that third-party `uses:` refs stay SHA-pinned,
 * so a future edit reverting `trufflehog@<sha>` to `@main` would pass CI
 * silently.
 *
 * This script scans `.github/workflows/*.yml` (and `*.yaml`), extracts every
 * `uses:` ref, and fails the build when a **third-party** action (anything
 * not under the first-party `actions/*` org) is pinned to a floating ref
 * instead of a full 40-char commit SHA. First-party `actions/*` refs are
 * allowed on major-version tags (`@v4`) — Dependabot's `github-actions`
 * ecosystem bumps those in-place, matching the rationale in the workflow
 * file headers.
 *
 * A "floating ref" is any of:
 *   - a branch head: `@main`, `@master`
 *   - a tag / partial-SHA that is not a full 40-hex-char commit SHA
 *     (`@v5`, `@v3.95.3`, `@release`, a 7-char short SHA, …)
 *
 * Contract:
 *   - Scans the workflows directory (default `.github/workflows`, override
 *     with `--dir <path>`).
 *   - Prints `<file>:<lineNo> <ref> — <reason>` for each violation, then a
 *     one-line summary even on a clean scan so operators see the "ok" signal.
 *   - With `--json`: writes a structured envelope to stdout and skips the
 *     human summary.
 *   - Exit codes: 0 = no violations; 1 = at least one floating third-party
 *     ref. A missing / empty workflows directory exits 0 (nothing to gate).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';

/**
 * Parse argv for `--dir <path>` and `--json`. Exported so unit tests can pin
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
 * Is the given ref suffix a full 40-char hex commit SHA?
 *
 * @param {string} ref The portion after the `@` in a `uses:` value.
 * @returns {boolean}
 */
export function isFullSha(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * Is the action a first-party `actions/*` action (e.g. `actions/checkout`)?
 * First-party refs are allowed to float on major-version tags because
 * Dependabot's `github-actions` ecosystem bumps them in-place.
 *
 * Local (`./…`) and reusable-workflow (`owner/repo/.github/workflows/x.yml`)
 * refs and Docker refs (`docker://…`) are out of scope for the SHA-pin gate;
 * `isFirstParty` only matters for `owner/repo[@ref]` registry actions.
 *
 * @param {string} action The portion before the `@` in a `uses:` value.
 * @returns {boolean}
 */
export function isFirstParty(action) {
  return /^actions\//.test(action);
}

/**
 * Pure helper: scan a single workflow file's text for `uses:` refs and return
 * the violations. A violation is a third-party `owner/repo@ref` where `ref`
 * is not a full 40-char SHA.
 *
 * Skips:
 *   - local actions (`uses: ./path`)
 *   - Docker refs (`uses: docker://…`)
 *   - first-party `actions/*` refs (allowed on major-version tags)
 *   - refs with no `@` (pinned by default branch implicitly — flagged as a
 *     violation: an unpinned third-party ref floats on the default branch)
 *
 * @param {string} file Relative file label used in violation rows.
 * @param {string} text The file contents.
 * @returns {Array<{ file: string, line: number, action: string, ref: string | null, reason: string }>}
 */
export function scanWorkflowText(file, text) {
  const violations = [];
  const lines = text.split(/\r?\n/);
  // Match `uses:` values, optionally quoted. The value runs until whitespace
  // or a `#` comment. Capture the raw value for downstream parsing.
  const usesRe = /^\s*(?:-\s*)?uses:\s*['"]?([^'"#\s]+)['"]?/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = usesRe.exec(lines[i]);
    if (!m) continue;
    const value = m[1];
    const lineNo = i + 1;
    // Local actions and Docker refs are out of scope for the SHA-pin gate.
    if (value.startsWith('./') || value.startsWith('docker://')) continue;
    const atIndex = value.indexOf('@');
    const action = atIndex === -1 ? value : value.slice(0, atIndex);
    const ref = atIndex === -1 ? null : value.slice(atIndex + 1);
    // First-party actions/* may float on major-version tags.
    if (isFirstParty(action)) continue;
    if (ref === null) {
      violations.push({
        file,
        line: lineNo,
        action,
        ref: null,
        reason: 'third-party action with no ref floats on the default branch',
      });
      continue;
    }
    if (!isFullSha(ref)) {
      const floating = ref === 'main' || ref === 'master';
      violations.push({
        file,
        line: lineNo,
        action,
        ref,
        reason: floating
          ? `third-party action pinned to branch head @${ref} (CWE-1357)`
          : `third-party action @${ref} is not a full 40-char commit SHA`,
      });
    }
  }
  return violations;
}

/**
 * Enumerate workflow files (`*.yml` / `*.yaml`) directly under `dir`.
 * Returns absolute paths sorted for deterministic output. A missing directory
 * yields an empty list.
 *
 * @param {string} dir Absolute workflows directory.
 * @returns {string[]}
 */
export function listWorkflowFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Pure helper: render the human-readable report. One line per violation
 * followed by a one-line summary. The summary carries a `(gate fail)` /
 * `(ok)` marker so the result is visible in CI output.
 *
 * @param {Array<{ file: string, line: number, action: string, ref: string | null, reason: string }>} violations
 * @returns {string}
 */
export function renderReport(violations) {
  const lines = [];
  for (const v of violations) {
    const refLabel = v.ref === null ? '(no ref)' : `@${v.ref}`;
    lines.push(`${v.file}:${v.line} ${v.action}${refLabel} — ${v.reason}`);
  }
  const tag = violations.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(`[action-pinning] violations=${violations.length} ${tag}`);
  return lines.join('\n');
}

/**
 * Top-level CLI entry. Exported so tests can drive the full pipeline against a
 * fixture workflows directory without touching the repo's real workflows.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} exit code: 0 = clean; 1 = floating third-party ref
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { dir, json } = parseArgv(argv);
  const resolvedDir = path.resolve(
    cwd,
    dir ?? path.join('.github', 'workflows'),
  );

  const files = listWorkflowFiles(resolvedDir);
  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    violations.push(...scanWorkflowText(path.relative(cwd, file), text));
  }

  const exitCode = violations.length > 0 ? 1 : 0;

  if (json) {
    const envelope = {
      kind: 'action-pinning-report',
      dir: resolvedDir,
      filesScanned: files.length,
      violations,
      exitCode,
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    if (files.length === 0) {
      stderr.write(
        `[action-pinning] ⚠ no workflow files found under ${resolvedDir}\n`,
      );
    }
    stdout.write(`\n--- action-pinning scan ---\n`);
    stdout.write(`${renderReport(violations)}\n`);
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'action-pinning',
  propagateExitCode: true,
  errorPrefix: '[action-pinning] ❌ Fatal error',
});
