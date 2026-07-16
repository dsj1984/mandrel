#!/usr/bin/env node
/**
 * .agents/scripts/generate-workflows-doc.js — Catalog-backed workflows index
 *
 * Renders the consumer-shipped slash-command catalog at
 * `.agents/docs/workflows.md` from the on-disk workflow set under
 * `.agents/workflows/*.md` (top-level only — `helpers/` are path-included
 * modules, not runnable slash commands). The catalog logic is shared with
 * the in-process backend in `lib/mandrel-catalog.js`, so the generated doc
 * and any programmatic catalog reader never drift from one another.
 *
 * Why generated (Story #3708): `workflows.md` used to be hand-maintained and
 * was *not* drift-gated, so it could silently fall out of sync with the
 * actual workflow set. The retired `/mandrel` discoverability command was
 * always accurate because it rendered the catalog live. Rather than keep the
 * drift-prone hand-authored doc and the accurate-but-ephemeral command, this
 * generator makes the doc itself a rendering of the same catalog, gates it via
 * `--check`, and ships it to consumers under `.agents/docs/`.
 *
 * Modes:
 *   (default)  — rewrites `.agents/docs/workflows.md` in full from the
 *                current workflow set.
 *   --check    — exits 0 when the on-disk file matches the freshly generated
 *                content, throws (→ exit 1) with a regeneration hint otherwise.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, unrecoverable failures
 * surface via `throw new Error(...)` so `runAsCli` maps the throw to
 * `process.exit(1)` deterministically (no `Logger.fatal`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { buildCatalog, buildLoopCatalog } from './lib/mandrel-catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, '.agents', 'workflows');
const DOC_PATH = path.join(PROJECT_ROOT, '.agents', 'docs', 'workflows.md');

/**
 * Collapse a catalog description to a single Markdown table-cell-safe line.
 * The catalog already normalizes whitespace; this neutralizes:
 *   - pipe characters (`|`) so a description can never break the table grid;
 *   - stray newlines;
 *   - bare emphasis markers (`*`, `_`) so a glob like `audit-*` in a
 *     description is rendered literally instead of being parsed as emphasis
 *     (which trips markdownlint MD037 in the generated doc).
 *
 * Framework workflow descriptions do not embed `*`/`_` inside inline code
 * spans, so a global escape is safe and keeps the generator pure.
 *
 * @param {string | null} description
 * @returns {string}
 */
function cellEscape(description) {
  if (!description) return '_(no description)_';
  return String(description)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/([*_])/g, '\\$1');
}

/**
 * Render the full generated `workflows.md` content from the flat command
 * catalog and the loop-unit catalog.
 *
 * @param {Array<{ name: string, description: string | null, vague: boolean }>} catalog
 * @param {Array<{ name: string, description: string | null, vague: boolean }>} [loopCatalog]
 * @returns {string}
 */
export function renderWorkflowsDoc(catalog, loopCatalog = []) {
  const lines = [
    '<!--',
    '  GENERATED FILE — do not edit by hand.',
    '  Source of truth: `.agents/workflows/*.md` front-matter `description:`.',
    '  Regenerate with: node .agents/scripts/generate-workflows-doc.js',
    '  Drift is gated by `npm run docs:check`.',
    '-->',
    '',
    '# Workflow (Slash-Command) Reference Index',
    '',
    'This is an **auto-generated reference index** of every slash command shipped',
    'under `.agents/workflows/` (top-level only — `helpers/` are path-included',
    'modules, not runnable commands). The canonical workflow narrative lives in',
    '[`SDLC.md`](SDLC.md) — read that first to understand how the commands',
    'compose. This file is only for "which command does X?" lookups.',
    '',
    'Every command file lives at `.agents/workflows/<name>.md` and is projected',
    'into a flat `.claude/commands/` tree by `npm run sync:commands` (kept',
    'current at install time and on every `mandrel sync`/`update`) so it shows',
    'up as a bare `/<name>` slash command (e.g. `/deliver`). The projection',
    'writes only `.claude/commands/<name>.md` — there is no plugin manifest and no',
    'marketplace listing. The commands load in every Claude Code environment.',
    '',
    'Loop units are the one namespaced exception: files under',
    '`.agents/workflows/loops/<name>.md` project to',
    '`.claude/commands/loops/<name>.md` and are invoked as the namespaced',
    '`/loops:<name>` command. On hosts that flatten subdirectory commands the',
    'same unit surfaces under the flat fallback `/loops-<name>`. They are',
    'listed separately in the **Loops namespace** section below.',
    '',
    'This index is regenerated from each workflow’s front-matter `description:`',
    'by `node .agents/scripts/generate-workflows-doc.js`; `npm run docs:check`',
    'fails when it drifts from the on-disk workflow set. To change a command’s',
    'description, edit the workflow file’s front-matter and regenerate.',
    '',
    `## Commands (${catalog.length})`,
    '',
    '| Command | Description |',
    '| --- | --- |',
  ];

  for (const entry of catalog) {
    lines.push(`| \`/${entry.name}\` | ${cellEscape(entry.description)} |`);
  }

  lines.push('');
  lines.push(`## Loops namespace (${loopCatalog.length})`);
  lines.push('');
  lines.push(
    'Loop units project to `.claude/commands/loops/<name>.md` and are invoked',
  );
  lines.push(
    'as `/loops:<name>` (flat fallback `/loops-<name>` on hosts that flatten',
  );
  lines.push('subdirectory commands).');
  lines.push('');
  if (loopCatalog.length === 0) {
    lines.push('> No loop units are shipped yet.');
  } else {
    lines.push('| Command | Description |');
    lines.push('| --- | --- |');
    for (const entry of loopCatalog) {
      lines.push(
        `| \`/loops:${entry.name}\` | ${cellEscape(entry.description)} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Build the canonical generated content and read the on-disk file (if any).
 *
 * @returns {{ generated: string, original: string | null }}
 */
export function buildExpected() {
  const catalog = buildCatalog(WORKFLOWS_DIR);
  const loopCatalog = buildLoopCatalog(WORKFLOWS_DIR);
  const generated = renderWorkflowsDoc(catalog, loopCatalog);
  const original = fs.existsSync(DOC_PATH)
    ? fs.readFileSync(DOC_PATH, 'utf8')
    : null;
  return { generated, original };
}

/**
 * @param {string[]} argv
 */
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const { generated, original } = buildExpected();
  const rel = path.relative(PROJECT_ROOT, DOC_PATH).split(path.sep).join('/');

  if (values.check) {
    if (original === generated) {
      Logger.info(`generate-workflows-doc: ${rel} is up to date.`);
      return;
    }
    throw new Error(
      `${rel} is out of date. ` +
        'Run `node .agents/scripts/generate-workflows-doc.js` to regenerate it.',
    );
  }

  if (original === generated) {
    Logger.info(`generate-workflows-doc: ${rel} already current — no write.`);
    return;
  }
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, generated, 'utf8');
  Logger.info(`generate-workflows-doc: wrote ${rel}.`);
}

export { DOC_PATH, WORKFLOWS_DIR };

runAsCli(import.meta.url, main, { source: 'generate-workflows-doc' });
