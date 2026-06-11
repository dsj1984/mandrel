#!/usr/bin/env node
/* node:coverage ignore file -- pre-push docs-freshness gate; pure git-mtime walk with no testable branching beyond filesystem state */

/**
 * .agents/scripts/validate-docs-freshness.js — Documentation Freshness Gate
 *
 * For each doc in `delivery.docsFreshness.paths` + `project.docsContextFiles`, verify
 * that the file was meaningfully updated during this Epic's lifecycle. A
 * file passes when **either** of the following holds:
 *
 *   1. `git log --all --grep="#<epicId>" -- <file>` returns a commit —
 *      the Epic ID was referenced in a commit message that touched the
 *      file.
 *   2. The file's current body contains `#<epicId>` — a human annotation
 *      (e.g., a CHANGELOG entry) explicitly ties the change to this Epic.
 *
 * The prior gate accepted any diff against the base branch — a stray
 * whitespace edit or a one-line unrelated cleanup passed, defeating the
 * purpose of the check. Requiring an Epic-ID reference makes "did you
 * update the docs for this Epic?" a falsifiable question instead of a
 * checkbox.
 *
 * Usage:
 *   node .agents/scripts/validate-docs-freshness.js --epic <EPIC_ID> [--base main] [--docs <comma-separated>] [--json]
 *
 * `--json` emits a single JSON object on stdout with
 *   { ok, epicId, results: [{ file, pass, reason }, ...] }
 * and suppresses the human-readable log lines. Intended for LLM/tool consumers
 * that need to enumerate failing files without parsing log output.
 *
 * Exit codes:
 *   0 — every doc has an Epic-ID reference.
 *   1 — one or more docs have no reference.
 *   2 — configuration error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';

/**
 * Resolve the canonical doc list for a release: `delivery.docsFreshness.paths`
 * entries plus `project.docsContextFiles` prefixed by `project.paths.docsRoot`.
 * Expects the full resolved config (`{ project, delivery, ... }`).
 *
 * @param {object} config
 * @returns {string[]}
 */
export function resolveDocList(config) {
  // Read from new shape first; fall back to the legacy shim/bag.
  const project = config?.project ?? config;
  const delivery = config?.delivery ?? null;
  const docsFreshnessPaths = Array.isArray(delivery?.docsFreshness?.paths)
    ? delivery.docsFreshness.paths
    : Array.isArray(config?.release?.docs)
      ? config.release.docs
      : [];
  const contextDocs = Array.isArray(project?.docsContextFiles)
    ? project.docsContextFiles
    : Array.isArray(config?.docsContextFiles)
      ? config.docsContextFiles
      : [];
  const docsRoot = getPaths(config).docsRoot ?? 'docs';
  const resolved = [
    ...docsFreshnessPaths,
    ...contextDocs.map((f) => path.posix.join(docsRoot, f)),
  ];
  return Array.from(new Set(resolved));
}

function epicRefMatcher(epicId) {
  // Match `#N` as a standalone token. `(?!\d)` prevents `#10` from
  // satisfying a search for `#1` — a subtle bug the prior diff-only gate
  // never had to guard against.
  return new RegExp(`#${epicId}(?!\\d)`);
}

function commitsMentioningEpic(docPath, epicId, cwd = PROJECT_ROOT) {
  const res = gitSpawn(
    cwd,
    'log',
    '--all',
    `--grep=#${epicId}`,
    '--pretty=format:%H',
    '--',
    docPath,
  );
  if (res.status !== 0) return [];
  return (res.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fileBodyMentionsEpic(
  docPath,
  epicId,
  cwd = PROJECT_ROOT,
  readFileImpl = fs.readFileSync,
) {
  const abs = path.isAbsolute(docPath) ? docPath : path.join(cwd, docPath);
  let body;
  try {
    body = readFileImpl(abs, 'utf8');
  } catch {
    return false;
  }
  return epicRefMatcher(epicId).test(body);
}

/**
 * Run the freshness gate against every resolved doc. Pure; takes
 * everything it needs as inputs so tests don't need a worktree.
 *
 * @param {{
 *   epicId: number,
 *   docs: string[],
 *   cwd?: string,
 *   readFileImpl?: typeof fs.readFileSync,
 *   commitsForFile?: (doc: string, epicId: number, cwd: string) => string[],
 * }} opts
 * @returns {{ ok: boolean, results: Array<{ file: string, pass: boolean, reason: string }> }}
 */
export function runFreshnessGate({
  epicId,
  docs,
  cwd = PROJECT_ROOT,
  readFileImpl = fs.readFileSync,
  commitsForFile = commitsMentioningEpic,
}) {
  const results = docs.map((file) => {
    const commits = commitsForFile(file, epicId, cwd);
    if (commits.length > 0) {
      return {
        file,
        pass: true,
        reason: `${commits.length} commit(s) reference Epic #${epicId}`,
      };
    }
    if (fileBodyMentionsEpic(file, epicId, cwd, readFileImpl)) {
      return {
        file,
        pass: true,
        reason: `body mentions #${epicId}`,
      };
    }
    return {
      file,
      pass: false,
      reason: `no commit message or body reference to #${epicId}`,
    };
  });
  return { ok: results.every((r) => r.pass), results };
}

/**
 * Pure: parse argv into the normalized CLI option bag.
 *
 * @param {string[]} argv
 * @returns {{ epicId: number|null, json: boolean, docsList: string[]|null }}
 */
export function parseFreshnessArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      base: { type: 'string' },
      docs: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: false,
  });
  const parsed = Number.parseInt(values.epic ?? '', 10);
  return {
    epicId: Number.isNaN(parsed) || parsed <= 0 ? null : parsed,
    json: values.json === true,
    docsList: values.docs
      ? values.docs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
  };
}

/** Pure: render a per-doc "ok / fail" line. */
export function renderFreshnessLine(result) {
  return `[docs-freshness] ${result.pass ? '✅' : '❌'} ${result.file} — ${result.reason}`;
}

/** Pure: build the failure message for the operator. */
export function renderFreshnessFailureMessage(epicId) {
  return (
    `[docs-freshness] ❌ Documentation freshness gate FAILED for Epic #${epicId}.\n\n` +
    `Update each failing file so its commit message or body references #${epicId}, ` +
    `then re-run /deliver.`
  );
}

/** Pure: success message. */
export function renderFreshnessSuccessMessage(epicId, count) {
  return `[docs-freshness] ✅ All ${count} doc(s) reference Epic #${epicId}.`;
}

function reportEmptyDocs(epicId, json) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, epicId, results: [] })}\n`,
    );
    return;
  }
  Logger.info(
    `[docs-freshness] ⏭  No docs configured under delivery.docsFreshness.paths or ` +
      `project.docsContextFiles — nothing to check.`,
  );
}

function reportGateOutcome({ epicId, json, ok, results }) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, epicId, results })}\n`);
    if (!ok) process.exit(1);
    return;
  }
  for (const r of results) Logger.info(renderFreshnessLine(r));
  if (ok) {
    Logger.info(renderFreshnessSuccessMessage(epicId, results.length));
    return;
  }
  Logger.error(renderFreshnessFailureMessage(epicId));
  process.exit(1);
}

async function main() {
  const args = parseFreshnessArgs(process.argv.slice(2));
  if (args.epicId === null) {
    throw new Error(
      'Usage: node validate-docs-freshness.js --epic <EPIC_ID> [--docs a.md,b.md] [--json]',
    );
  }
  const { epicId, json, docsList } = args;
  const config = resolveConfig();
  const docs = docsList ?? resolveDocList(config);
  if (docs.length === 0) {
    reportEmptyDocs(epicId, json);
    return;
  }
  const { ok, results } = runFreshnessGate({ epicId, docs });
  reportGateOutcome({ epicId, json, ok, results });
}

runAsCli(import.meta.url, main, { source: 'validate-docs-freshness' });
