/**
 * cyclomatic-scope.js — narrow cyclomatic scoring to the only files that can
 * produce a ratchet verdict: every baseline-recorded file (improved /
 * worsened / removed) plus everything changed against the base branch,
 * including staged, unstaged and untracked work (added).
 *
 * @module lib/cyclomatic-scope
 */

import path from 'node:path';
import { createGitInterface } from './git-utils.js';
import { isIgnoredByGlobs } from './maintainability-utils.js';

/**
 * `diff HEAD` already covers staged and unstaged, so no `--cached` pass.
 *
 * @type {ReadonlyArray<ReadonlyArray<string>>}
 */
const CHANGE_PROBES = Object.freeze([
  Object.freeze(['diff', '--name-only', '__BASE__...HEAD']),
  Object.freeze(['diff', '--name-only', 'HEAD']),
  Object.freeze(['ls-files', '--others', '--exclude-standard']),
]);

/**
 * Fails open: any git failure returns `null` (scan everything) — narrowing
 * on an unreadable scope is how a ratchet silently stops ratcheting.
 *
 * @param {{
 *   cwd: string,
 *   baseRef: string,
 *   baselineRows?: Array<{ file?: string }>,
 *   git?: ReturnType<typeof createGitInterface>,
 * }} args
 * @returns {Set<string> | null}
 */
function resolveCyclomaticScope({ cwd, baseRef, baselineRows = [], git }) {
  const gitIface = git ?? createGitInterface({});
  const scope = new Set();
  for (const row of baselineRows) {
    if (typeof row?.file === 'string' && row.file) scope.add(row.file);
  }
  for (const probe of CHANGE_PROBES) {
    const argv = probe.map((arg) =>
      arg === '__BASE__...HEAD' ? `${baseRef}...HEAD` : arg,
    );
    const res = gitIface.gitSpawn(cwd, ...argv);
    if (res?.status !== 0) return null;
    for (const line of String(res.stdout ?? '').split('\n')) {
      const file = line.trim().replace(/\\/g, '/');
      if (file) scope.add(file);
    }
  }
  return scope;
}

/**
 * `--update` and `BASELINE_SCOPE=full` must see the whole tree.
 *
 * @param {{
 *   cwd: string,
 *   config?: { project?: { baseBranch?: string } } | null,
 *   update?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   baselineRows?: Array<{ file?: string }>,
 *   git?: ReturnType<typeof createGitInterface>,
 * }} args
 * @returns {Set<string> | null}
 */
export function resolveScanScope({
  cwd,
  config = null,
  update = false,
  env = process.env,
  baselineRows = [],
  git,
}) {
  if (update || env?.BASELINE_SCOPE === 'full') return null;
  return resolveCyclomaticScope({
    cwd,
    baseRef: config?.project?.baseBranch ?? 'main',
    baselineRows,
    git,
  });
}

/**
 * @param {string[]} files
 * @param {{ cwd: string, ignoreGlobs?: string[], scopeFiles?: Set<string> | null }} args
 * @returns {Array<{ abs: string, rel: string }>}
 */
export function selectFilesToScore(
  files,
  { cwd, ignoreGlobs = [], scopeFiles = null },
) {
  const selected = [];
  for (const abs of files) {
    if (isIgnoredByGlobs(abs, ignoreGlobs, cwd)) continue;
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    if (scopeFiles && !scopeFiles.has(rel)) continue;
    selected.push({ abs, rel });
  }
  return selected;
}
