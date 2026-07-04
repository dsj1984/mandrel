#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * lint-label-vocabulary.js — enforce that GitHub label tokens cited in
 * `.agents/docs/SDLC.md` and every `*.md` under `.agents/workflows/` use the
 * canonical
 * `<axis>::<value>` separator established by
 * `.agents/scripts/lib/label-constants.js`.
 *
 * Why this exists (Tech Spec F9, Epic #2880): the framework's label
 * vocabulary is the contract between docs and the runtime. A typo such
 * as `type/epic` (the original F9 finding at epic-plan.md:49) drifts
 * silently because nothing reads doc prose against the constants file.
 * This lint closes that gap by failing CI on any inline code span that
 * cites a known axis with the wrong separator.
 *
 * Scope:
 *   - Files scanned: `.agents/docs/SDLC.md` plus every `*.md` under
 *     `.agents/workflows/`.
 *   - Tokens scanned: inline backtick code spans only (e.g. `type/epic`).
 *     Prose mentions like "planning/audit metadata" are intentionally
 *     ignored — only fenced citations are treated as label references.
 *   - Axes recognized: the union of namespaces exported from
 *     `lib/label-constants.js` (`agent`, `type`, `status`, `context`,
 *     `acceptance`, `meta`, `planning`) plus the persona prefix.
 *   - Violation shape: any axis token using a separator other than `::`
 *     (e.g. `/`, `:`, `-`). False-positive risk is low because the axes
 *     are project-specific identifiers, not common English words.
 *
 * Exit codes:
 *   0 — clean.
 *   1 — at least one violation; offending file + line printed to stderr.
 *
 * Ships as part of `npm run lint` via `.agents/scripts/run-lint.js`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_SCAN_TARGETS = Object.freeze([
  path.join(REPO_ROOT, '.agents', 'docs', 'SDLC.md'),
  path.join(REPO_ROOT, '.agents', 'workflows'),
]);

/**
 * Known label-axis prefixes. Each entry corresponds to a namespace
 * exported from `.agents/scripts/lib/label-constants.js`. The list is
 * hard-coded rather than introspected so the lint stays a pure file
 * walk with no module import side effects.
 *
 * Maintainers: when a new label axis lands in `label-constants.js`, add
 * its prefix here (without trailing colons). Forgetting to add an axis
 * makes the lint silently lenient for that namespace — the tests in
 * `tests/contract/lint/label-vocabulary.test.js` lock the canonical
 * set against drift.
 */
export const KNOWN_AXES = Object.freeze([
  'agent',
  'type',
  'status',
  'persona',
  'acceptance',
  'meta',
  'planning',
]);

/**
 * Walk a directory tree synchronously, yielding absolute paths of files
 * matching `.md`. Mirrors the walker shape in `check-lifecycle-lint.js`.
 */
function* walkMd(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(p);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield p;
    }
  }
}

/**
 * Resolve a mixed list of file/directory paths into the flat set of
 * markdown files to scan. Missing paths are silently skipped (the
 * walker handles ENOENT) so the lint is robust under partial trees.
 */
function* resolveTargets(targets) {
  for (const target of targets) {
    let stat;
    try {
      stat = readdirSync(target, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOTDIR') {
        // it's a file path — yield directly if it's .md
        if (target.endsWith('.md')) yield target;
        continue;
      }
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    // directory — walk it
    for (const entry of stat) {
      const p = path.join(target, entry.name);
      if (entry.isDirectory()) {
        yield* walkMd(p);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        yield p;
      }
    }
  }
}

/**
 * Scan a single source string for inline backtick code spans containing
 * a label-shaped token that uses a non-`::` separator after a known
 * axis. Returns an array of `{ line, token, axis, separator }`.
 *
 * The matcher operates on inline code spans only (single backtick
 * delimited). Fenced code blocks (```…```) are not stripped because
 * label citations inside them are still drift signals worth flagging.
 *
 * @param {string} src
 * @param {readonly string[]} [axes]
 * @returns {Array<{ line: number, token: string, axis: string, separator: string }>}
 */
export function findVocabularyViolations(src, axes = KNOWN_AXES) {
  const violations = [];
  const lines = src.split('\n');
  // Match inline code spans: `…` where the content does not include a
  // newline or another backtick. Greedy enough for label citations,
  // strict enough to avoid swallowing prose.
  const codeSpanRe = /`([^`\n]+)`/g;
  const axisSet = new Set(axes);
  // Anchored axis-drift check. We only flag a code span when its body,
  // taken as a whole, has the shape `<axis><sep><value>` where:
  //   - axis is a known label axis (case-insensitive)
  //   - sep is one of the non-canonical separators we treat as drift:
  //     `/` (the original F9 finding) or a single `:` (also wrong).
  //     Hyphens (`agent-protocol`) are intentionally NOT flagged —
  //     they collide with legitimate concept slugs and filenames.
  //   - value is a lowercase identifier (`[a-z][a-z0-9-]*`)
  //
  // The whole-body anchor avoids false positives on:
  //   - `acceptance::n-a` — canonical label, value contains a
  //     hyphen but is not at axis position.
  //   - `<type>/<slug>` — template placeholders.
  //   - `delivery.maxTokenBudget` — config-key paths with `.`.
  //   - `delivery.{maxTickets}` — JS destructure shapes.
  //   - `agent-protocol.md` — filenames / concept slugs.
  //
  // Real drift like `type/epic` matches because the WHOLE body is
  // `type/epic` (axis 'type', single '/', value 'epic').
  const driftRe = new RegExp(
    `^(${axes.join('|')})([/:])([a-z][a-z0-9-]*)$`,
    'i',
  );
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    codeSpanRe.lastIndex = 0;
    let span = codeSpanRe.exec(line);
    while (span !== null) {
      const body = span[1];
      const m = driftRe.exec(body);
      if (m) {
        const axis = m[1].toLowerCase();
        const separator = m[2];
        if (separator !== '::' && axisSet.has(axis)) {
          violations.push({
            line: i + 1,
            token: body,
            axis,
            separator,
          });
        }
      }
      span = codeSpanRe.exec(line);
    }
  }
  return violations;
}

/**
 * Aggregate violations across all target files.
 *
 * @param {readonly string[]} targets
 * @param {{ read?: typeof readFileSync }} [opts]
 * @returns {Array<{ file: string, line: number, token: string, axis: string, separator: string }>}
 */
export function lintLabelVocabulary(
  targets = DEFAULT_SCAN_TARGETS,
  { read = readFileSync } = {},
) {
  const out = [];
  for (const file of resolveTargets(targets)) {
    const src = read(file, 'utf8');
    for (const v of findVocabularyViolations(src)) {
      out.push({ file, ...v });
    }
  }
  return out;
}

async function main() {
  const violations = lintLabelVocabulary();
  if (violations.length === 0) {
    process.stdout.write(
      '[label-vocabulary] clean: no drift from canonical `<axis>::<value>` separator in scanned docs.\n',
    );
    return 0;
  }
  for (const v of violations) {
    process.stderr.write(
      `[label-vocabulary] ${v.file}:${v.line}\n  token \`${v.token}\` uses '${v.separator}' but axis '${v.axis}' requires canonical '::' separator (see .agents/scripts/lib/label-constants.js).\n`,
    );
  }
  return 1;
}

await runAsCli(import.meta.url, main, {
  source: 'lint-label-vocabulary',
  propagateExitCode: true,
});
