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

/** A markdown table row (leading pipe, optionally indented). */
const TABLE_ROW_RE = /^\s*\|/;
/** A markdown heading of any level — the lookback boundary for Rule 4. */
const HEADING_RE = /^\s*#{1,6}\s/;
/** A backticked `--flag` occupying a table row's first cell. */
const FLAG_CELL_RE = /^\s*\|\s*`?--[\w-]+/;
/** A `.js` script filename — bare or path-qualified. */
const SCRIPT_NAME_RE = /([\w./-]*[\w-]+\.js)\b/;
/** A markdown table's delimiter row (`| --- | --- |`). */
const TABLE_DELIMITER_RE = /^\s*\|[\s|:-]+\|?\s*$/;
/** Minimum `--flag` rows before a table counts as a flag *table*. */
export const MIN_FLAG_ROWS = 2;

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
 * Rule 4 — CLI flag table. Find markdown tables that enumerate the `--flags`
 * of a script the repo already owns, and flag them as duplicated surface.
 *
 * The script's own argument parser is the source of truth for its flags, and
 * it prints them itself; a copy in prose is drift waiting to happen (the very
 * drift Story #4546 removed). Prose must point at the command instead.
 *
 * The signal is deliberately narrow, to stay at zero false positives:
 *
 *   1. The table has at least `MIN_FLAG_ROWS` data rows whose **first cell**
 *      is a `--flag`. One flag row among prose rows is a contract/behaviour
 *      table (e.g. "Default | …", "`--dry-run` | …"), not a flag enumeration.
 *   2. A `.js` script is named between the table and the nearest preceding
 *      heading (inclusive) — i.e. the section is *about* that script, so the
 *      table is restating its surface.
 *
 * A slash command's own argument table (`/plan`, `/deliver`) has no script
 * behind it — nothing owns those flags but the workflow prose itself — so
 * condition 2 leaves it alone by design.
 *
 * @param {string[]} rawLines unstripped source lines (fenced commands are the
 *   usual place a script is named, so this rule reads the original text).
 * @returns {Array<{ rule: string, line: number, hint: string }>}
 */
export function lintFlagTables(rawLines) {
  const violations = [];
  let inFence = false;

  for (let i = 0; i < rawLines.length; i++) {
    if (/^\s*(```|~~~)/.test(rawLines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !TABLE_ROW_RE.test(rawLines[i])) continue;

    // Collect the contiguous table block starting here.
    const start = i;
    let end = i;
    while (end + 1 < rawLines.length && TABLE_ROW_RE.test(rawLines[end + 1])) {
      end += 1;
    }
    i = end; // continue scanning after this table

    const flagRows = rawLines
      .slice(start, end + 1)
      .filter((l) => !TABLE_DELIMITER_RE.test(l) && FLAG_CELL_RE.test(l));
    if (flagRows.length < MIN_FLAG_ROWS) continue;

    // Look back to the nearest heading (inclusive) for a named script.
    let script = null;
    for (let j = start - 1; j >= 0; j--) {
      const m = SCRIPT_NAME_RE.exec(rawLines[j]);
      if (m) {
        script = m[1];
        break;
      }
      if (HEADING_RE.test(rawLines[j])) break;
    }
    if (!script) continue;

    const base = script.split('/').pop();
    violations.push({
      rule: 'no-cli-flag-table',
      line: start + 1,
      hint:
        `Workflow prose restates the flag surface of \`${base}\` as a table (${flagRows.length} flag rows). ` +
        "The script's argument parser owns those flags, so a prose copy is drift waiting to happen. " +
        `Delete the table and point at the command (\`node .agents/scripts/${base} …\`), keeping only the ` +
        'judgement a reader cannot get from the command itself. If the script has no help output to point ' +
        'at, add one — do not re-inline the table.',
    });
  }
  return violations;
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
  const rawLines = source.split('\n');
  const lines = stripFences(source);
  violations.push(...lintFlagTables(rawLines));
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
