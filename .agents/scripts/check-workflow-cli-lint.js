#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * check-workflow-cli-lint.js — enforce the "no workflow instructs a
 * no-CLI library call" rule (Epic #4474 PR5; sibling of
 * check-lifecycle-lint.js).
 *
 * The measured failure mode this rule kills: workflow prose that tells the
 * host LLM to "Call `someExportedFunction({...})` exported from
 * `lib/whatever.js`". There is no runnable form of that instruction, so the
 * model greps the framework source and writes throwaway `.mjs` shims to
 * invoke the export — the mandrel-bench N=2 cohort measured ~12–15 turns of
 * shim-writing per plan for exactly this pattern. Workflows must instruct
 * `node .agents/scripts/<cli>.js …` commands instead.
 *
 * Scope: every `*.md` under `.agents/workflows/`.
 *
 * Heuristic (tuned to zero false positives on the surviving corpus —
 * descriptive mentions like "the automatic paths call `foo()`" are prose
 * about script internals, not instructions, and are NOT flagged):
 *
 *   Rule 1 — imperative library call. A paragraph (fenced code blocks
 *     stripped; lines joined) matching /\b(Call|Invoke)\s+`ident\s*\(/ —
 *     a capitalized imperative directly instructing a function call.
 *
 *   Rule 2 — "exported from" instruction. A paragraph containing both a
 *     backticked call token (`ident(`) and the phrase "exported from" —
 *     the canonical shape of the retired Phase 2/3/4 prose.
 *
 *   Rule 3 — prose-level lib import. `import(` / `require(` naming a
 *     `scripts/lib/` path OUTSIDE a fenced code block. (A complete,
 *     runnable `node -e` one-liner inside a fenced block is exempt: it
 *     costs zero shim-writing turns because it is executable as written.)
 *
 * Exit codes:
 *   0 — clean.
 *   1 — at least one violation; offending file + paragraph line printed
 *       to stderr.
 *
 * Ships as part of `npm run lint` (run-lint.js task list), alongside the
 * lifecycle lint and the label-vocabulary lint.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_WORKFLOWS_DIR = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
);

const IMPERATIVE_CALL_RE = /\b(?:Call|Invoke)\s+`[A-Za-z_$][\w$]*\s*\(/;
const BACKTICK_CALL_RE = /`[A-Za-z_$][\w$]*\s*\(/;
const EXPORTED_FROM_RE = /\bexported from\b/;
const LIB_IMPORT_RE = /\b(?:import|require)\(\s*['"`][^'"`]*scripts\/lib\//;

/**
 * Strip fenced code blocks (``` / ~~~), replacing their lines with empty
 * strings so line numbers stay stable. Complete runnable commands live in
 * fences and are exempt by design (see header).
 *
 * @param {string} source
 * @returns {string[]} lines with fenced content blanked.
 */
export function stripFences(source) {
  const lines = source.split('\n');
  let inFence = false;
  return lines.map((line) => {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/**
 * Split blanked lines into paragraphs — runs of consecutive non-empty
 * lines — keeping the 1-based line number of each paragraph's first line.
 *
 * @param {string[]} lines
 * @returns {Array<{ text: string, line: number }>}
 */
export function toParagraphs(lines) {
  const paragraphs = [];
  let buf = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      if (buf.length === 0) start = i + 1;
      buf.push(lines[i]);
    } else if (buf.length > 0) {
      paragraphs.push({ text: buf.join(' '), line: start });
      buf = [];
    }
  }
  if (buf.length > 0) paragraphs.push({ text: buf.join(' '), line: start });
  return paragraphs;
}

/**
 * Lint one markdown source. Returns violations
 * `{ rule, line, hint }[]` (empty when clean).
 *
 * @param {string} source markdown content.
 * @returns {Array<{ rule: string, line: number, hint: string }>}
 */
export function lintWorkflowSource(source) {
  const violations = [];
  const lines = stripFences(source);
  for (const para of toParagraphs(lines)) {
    if (IMPERATIVE_CALL_RE.test(para.text)) {
      violations.push({
        rule: 'no-cli-library-call',
        line: para.line,
        hint:
          'Workflow prose instructs calling a function directly ("Call/Invoke `fn(...)`"). ' +
          'There is no runnable form of that instruction — the model must write a throwaway shim. ' +
          'Instruct a `node .agents/scripts/<cli>.js …` command instead (add a CLI if none exists).',
      });
      continue;
    }
    if (EXPORTED_FROM_RE.test(para.text) && BACKTICK_CALL_RE.test(para.text)) {
      violations.push({
        rule: 'no-cli-library-call',
        line: para.line,
        hint:
          'Workflow prose points at an exported library function ("`fn(...)` exported from …") ' +
          'with no CLI entrypoint. Instruct a `node .agents/scripts/<cli>.js …` command instead.',
      });
      continue;
    }
    if (LIB_IMPORT_RE.test(para.text)) {
      violations.push({
        rule: 'no-prose-lib-import',
        line: para.line,
        hint:
          'Workflow prose (outside a fenced code block) instructs importing a scripts/lib module. ' +
          'Give a complete runnable command in a fenced block, or add a CLI entrypoint.',
      });
    }
  }
  return violations;
}

/**
 * Recursively collect `*.md` files under a directory.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths.
 */
export function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...collectMarkdown(abs));
    else if (entry.endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * Run the check over a workflows directory. Exported for tests (pass a
 * fixture directory).
 *
 * @param {string} [workflowsDir]
 * @returns {Array<{ file: string, rule: string, line: number, hint: string }>}
 */
export function runCheck(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  const violations = [];
  for (const file of collectMarkdown(workflowsDir)) {
    const source = readFileSync(file, 'utf8');
    for (const v of lintWorkflowSource(source)) {
      violations.push({ file: path.relative(REPO_ROOT, file), ...v });
    }
  }
  return violations;
}

async function main() {
  const violations = runCheck();
  if (violations.length === 0) {
    process.stdout.write(
      '[workflow-cli-lint] clean: no workflow instructs a no-CLI library call.\n',
    );
    return 0;
  }
  for (const v of violations) {
    process.stderr.write(
      `[workflow-cli-lint][${v.rule}] ${v.file}:${v.line}\n  ${v.hint}\n`,
    );
  }
  return 1;
}

await runAsCli(import.meta.url, main, {
  source: 'check-workflow-cli-lint',
  propagateExitCode: true,
});
