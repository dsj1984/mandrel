#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-audit-recheck.js — Cross-phase re-trigger selector.
 *
 * Story #2619 (Epic #2586). Read a list of touched files (provided by the
 * caller after the code-review auto-fix loop in
 * `.agents/workflows/helpers/code-review.md` Step 4.6) and emit the
 * subset of audit lenses whose `filePatterns` overlap that list.
 *
 * The CLI is intentionally narrower than `lib/audit-suite/selector.js`: it does NOT
 * run a git diff and does NOT consult the Epic ticket body for keyword
 * triggers. The auto-fix tail already knows exactly which paths it touched —
 * only file-pattern overlap is relevant for deciding which lenses are stale
 * and need re-invocation.
 *
 * Tier gate (Epic #4405): this is the **Epic-close** re-check, so it emits
 * only non-`local` lenses. A `local`-tier lens is verified shift-left at
 * write-time and Story-scope review; re-running it here would verify the same
 * concern at a second tier. The overlap set is therefore filtered through
 * `resolveLensTier`, dropping every `local` lens (including the universal
 * `audit-clean-code`) so a focused-fix commit cannot drag one back into the
 * Epic-close re-check.
 *
 * Usage:
 *   node .agents/scripts/epic-audit-recheck.js \
 *     --epic <id> --files <comma-list-or-@file>
 *
 *   --files comma-list:  --files src/auth/login.js,src/api/users.ts
 *   --files @path:       --files @temp/touched.txt  (newline-delimited)
 *
 * Output: a single JSON envelope on stdout:
 *   {
 *     epicId,
 *     selectedAudits: string[],   // lenses whose filePatterns overlap input
 *     context: {
 *       changedFiles: string[],   // normalized input list (dedup, non-empty)
 *       changedFilesCount: number,
 *     }
 *   }
 *
 * Exit codes:
 *   0 — emitted envelope (selectedAudits MAY be empty when no lens overlaps)
 *   2 — validation error (missing --epic, missing --files, unreadable
 *        @file). Error message written to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  matchesAnyFilePattern,
  resolveLensTier,
} from './lib/audit-suite/index.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';

const HELP = `Usage: node .agents/scripts/epic-audit-recheck.js \\
  --epic <id> --files <comma-list-or-@file>

Flags:
  --epic   GitHub Epic issue number (required).
  --files  Comma-separated list of touched file paths, OR @<path> to read
           a newline-delimited list from a file (required). Empty entries
           are stripped.
  --help   Show this message.
`;

export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      epic: { type: 'ticket' },
      files: { type: 'string' },
      help: { type: 'boolean' },
    },
    argv,
  );
  return values;
}

/**
 * Normalize a `--files` value into a deduped array of non-empty paths.
 * Accepts either a comma-separated literal or `@<path>` (newline-delimited
 * file). Returns `{ files, error }` — exactly one is populated.
 *
 * @param {string} raw
 * @param {{ readFileSync?: typeof fs.readFileSync, cwd?: string }} [deps]
 */
export function resolveFilesArg(raw, deps = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: '[epic-audit-recheck] --files is required.' };
  }
  const readFile = deps.readFileSync ?? fs.readFileSync;
  const cwd = deps.cwd ?? process.cwd();

  let listText = raw;
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    if (!filePath) {
      return { error: '[epic-audit-recheck] --files @<path> missing path.' };
    }
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(cwd, filePath);
    try {
      listText = readFile(absPath, 'utf8');
    } catch (err) {
      return {
        error: `[epic-audit-recheck] Failed to read ${absPath}: ${err.message}`,
      };
    }
  }

  // Comma or newline are both valid delimiters — the @file form is
  // newline-delimited, the inline form is comma-delimited. Splitting on
  // either keeps both code paths converging on the same normalizer.
  const seen = new Set();
  const files = [];
  for (const token of listText.split(/[\n,]/)) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    files.push(trimmed);
  }
  return { files };
}

/**
 * Load the audit-rules document validated elsewhere by
 * `lib/audit-suite/selector.js`. Surfaced as a separate function so tests
 * can swap a fixture in without touching the on-disk schema file.
 *
 * @param {{ readFileSync?: typeof fs.readFileSync }} [deps]
 */
export function loadAuditRules(deps = {}) {
  const config = resolveConfig();
  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths(config).schemasRoot,
    'audit-rules.json',
  );
  const read = deps.readFileSync ?? fs.readFileSync;
  let text;
  try {
    text = read(rulesPath, 'utf8');
  } catch (err) {
    throw new Error(
      `[epic-audit-recheck] Failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }
  return JSON.parse(text);
}

/**
 * Pure overlap detector. Walks the audit-rules document and returns the
 * names of every **non-`local`** audit whose `triggers.filePatterns` matches
 * at least one entry in `files`. Lenses without `filePatterns` (or with an
 * empty array) NEVER appear in the output — keyword triggers are
 * intentionally ignored: this CLI answers "what was invalidated by the
 * touched paths?", not "what should I run from scratch?".
 *
 * The output is additionally gated by tier (Epic #4405): a `local`-tier lens
 * is verified shift-left (write-time + Story-scope) and is never re-run at
 * Epic close, so it is dropped here even when its patterns overlap. This
 * matters now that `audit-clean-code` carries the universal `**` glob — its
 * overlap is universal, so without the tier gate every focused-fix commit
 * would drag it (and any other local lens) back into the Epic-close re-check.
 *
 * @param {{ audits: Record<string, { triggers?: { filePatterns?: string[] } }> }} rules
 * @param {string[]} files
 * @param {(lens: string) => string} [resolveLensTierFn] tier resolver
 *   (injectable seam; defaults to {@link resolveLensTier}).
 */
export function selectOverlappingAudits(
  rules,
  files,
  resolveLensTierFn = resolveLensTier,
) {
  const selected = [];
  for (const [auditName, ruleOpts] of Object.entries(rules?.audits ?? {})) {
    const patterns = ruleOpts?.triggers?.filePatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) continue;
    if (!matchesAnyFilePattern(patterns, files)) continue;
    // Epic-close tier gate: skip `local` lenses (verified shift-left). A
    // malformed/unknown tier is drift the schema guards against — skip it
    // rather than throw the whole selection.
    let tier;
    try {
      tier = resolveLensTierFn(auditName);
    } catch {
      continue;
    }
    if (tier === 'local') continue;
    selected.push(auditName);
  }
  return selected;
}

/**
 * Pure pipeline body. Returns `{ exitCode, result }` where
 * `result.kind` is `'help' | 'validation-error' | 'envelope'`. `main`
 * renders these; tests drive this directly.
 */
export async function runEpicAuditRecheckCli(values, deps = {}) {
  const helpText = deps.help ?? HELP;
  if (values.help) {
    return { exitCode: 0, result: { kind: 'help', text: helpText } };
  }

  const { epic, files: filesRaw } = values;

  if (!Number.isFinite(epic) || epic <= 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: '[epic-audit-recheck] --epic <id> is required.',
        help: helpText,
      },
    };
  }

  const filesResult = (deps.resolveFilesArg ?? resolveFilesArg)(filesRaw, deps);
  if (filesResult.error) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: filesResult.error,
        help: helpText,
      },
    };
  }

  const rules = (deps.loadAuditRules ?? loadAuditRules)(deps);
  const selectedAudits = (
    deps.selectOverlappingAudits ?? selectOverlappingAudits
  )(rules, filesResult.files);

  const envelope = {
    epicId: epic,
    selectedAudits,
    context: {
      changedFiles: filesResult.files,
      changedFilesCount: filesResult.files.length,
    },
  };

  return { exitCode: 0, result: { kind: 'envelope', envelope } };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  const { exitCode, result } = await runEpicAuditRecheckCli(values);

  if (result.kind === 'help') {
    process.stdout.write(result.text);
    return;
  }
  if (result.kind === 'validation-error') {
    process.stderr.write(`${result.message}\n${result.help}`);
    process.exit(exitCode);
  }
  process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'epic-audit-recheck' });
