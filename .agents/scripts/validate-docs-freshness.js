#!/usr/bin/env node

/**
 * .agents/scripts/validate-docs-freshness.js — Documentation Freshness Gate
 *
 * For each doc in `delivery.docsFreshness.paths` + `project.docsContextFiles`, verify
 * that the file was meaningfully updated during this Epic's lifecycle. A
 * file passes when **either** of the following holds:
 *
 *   1. `git log --all --grep="#<epicId>" -- <file>` returns a commit —
 *      the Epic ID was referenced in a commit message that touched the
 *      file. This is the pass path for **every** doc.
 *   2. The file's current body contains `#<epicId>` — but this
 *      body-annotation path is accepted **only for changelog-class files**
 *      (basename matches `/changelog/i`), where an appended release note
 *      keyed to the Epic is the legitimate, expected update. Any other doc
 *      (architecture, decisions, README, …) MUST pass via condition 1: the
 *      living doc has to be **rewritten in an Epic-referencing commit**, not
 *      merely annotated with `#<epicId>`.
 *
 * The prior gate accepted any diff against the base branch — a stray
 * whitespace edit or a one-line unrelated cleanup passed, defeating the
 * purpose of the check. Requiring an Epic-ID reference makes "did you
 * update the docs for this Epic?" a falsifiable question instead of a
 * checkbox. The changelog-only restriction on condition 2 closes the
 * follow-on perverse incentive: without it, the gate rewarded appending
 * `#<epicId>` history into living docs (manufacturing fake provenance) to
 * satisfy the check. Restricting the annotation path to changelog files
 * makes the gate ask "was this doc rewritten for the Epic?" rather than
 * "does it mention the Epic?".
 *
 * Usage:
 *   node .agents/scripts/validate-docs-freshness.js --epic <EPIC_ID> [--docs <comma-separated>] [--json]
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

/**
 * A doc is "changelog-class" when its basename matches `/changelog/i`
 * (e.g. `CHANGELOG.md`, `docs/CHANGELOG.md`, `changelog.mdx`). Only these
 * files may satisfy the freshness gate via a body annotation (pass
 * condition 2); every other doc must pass via an Epic-referencing commit
 * (pass condition 1).
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isChangelogClass(file) {
  return /changelog/i.test(path.basename(file));
}

function epicRefMatcher(epicId) {
  // Match `#N` as a standalone token. `(?!\d)` prevents `#10` from
  // satisfying a search for `#1` — a subtle bug the prior diff-only gate
  // never had to guard against.
  return new RegExp(`#${epicId}(?!\\d)`);
}

/* node:coverage disable -- real `git log` shell-out; exercised via the
   injectable `commitsForFile` seam in runFreshnessGate, not directly. */
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
/* node:coverage enable */

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
    // Pass condition 2 (body annotation) is restricted to changelog-class
    // files. For every other doc, an appended `#<epicId>` no longer passes —
    // the living doc must be rewritten in an Epic-referencing commit.
    const changelogClass = isChangelogClass(file);
    if (
      changelogClass &&
      fileBodyMentionsEpic(file, epicId, cwd, readFileImpl)
    ) {
      return {
        file,
        pass: true,
        reason: `changelog body annotation references #${epicId}`,
      };
    }
    return {
      file,
      pass: false,
      reason: changelogClass
        ? `no commit message or changelog body reference to #${epicId}`
        : `${file} was not rewritten in an Epic-referencing commit for #${epicId} — ` +
          `living docs must be REWRITTEN in a commit whose message references ` +
          `#${epicId} (not annotated with #${epicId}); the body-annotation path ` +
          `passes only for changelog-class files`,
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

/**
 * Pure: build the failure message for the operator. Names the failing
 * file(s) and states the rewrite-not-append contract explicitly.
 *
 * @param {number} epicId
 * @param {Array<{ file: string, pass: boolean }>} [results]
 */
export function renderFreshnessFailureMessage(epicId, results = []) {
  const failing = results.filter((r) => !r.pass).map((r) => r.file);
  const fileList = failing.length > 0 ? failing.join(', ') : '(see rows above)';
  return (
    `[docs-freshness] ❌ Documentation freshness gate FAILED for Epic #${epicId}.\n\n` +
    `Failing file(s): ${fileList}\n\n` +
    `Living docs satisfy this gate by being REWRITTEN in an Epic-referencing ` +
    `commit — a commit whose message references #${epicId} and touches the ` +
    `file — NOT by appending a #${epicId} annotation to the body. The ` +
    `body-annotation path passes ONLY for changelog-class files (basename ` +
    `matches /changelog/i). Rewrite each failing file for the Epic, then ` +
    `re-run /deliver.`
  );
}

/** Pure: success message. */
export function renderFreshnessSuccessMessage(epicId, count) {
  return `[docs-freshness] ✅ All ${count} doc(s) reference Epic #${epicId}.`;
}

/* node:coverage disable -- process I/O + real config/git wiring (stdout,
   process.exit, resolveConfig, runAsCli); the pure logic these thin wrappers
   call is covered directly above. */
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
  Logger.error(renderFreshnessFailureMessage(epicId, results));
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
/* node:coverage enable */
