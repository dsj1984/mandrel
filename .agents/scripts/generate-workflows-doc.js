#!/usr/bin/env node
/**
 * Renders `.agents/docs/workflows.md` from the top-level workflow set via the
 * shared `lib/mandrel-catalog.js`, so the doc and programmatic readers cannot
 * drift; `--check` gates it.
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

/**
 * The `--root` seam lets the drift gate's test use a fixture root: mutating
 * the real workflow file dirties the shared checkout for parallel test files.
 * @param {string} [root]
 * @returns {{ root: string, workflowsDir: string, docPath: string }}
 */
export function resolveTargets(root) {
  const resolved = root ? path.resolve(root) : PROJECT_ROOT;
  return {
    root: resolved,
    workflowsDir: path.join(resolved, '.agents', 'workflows'),
    docPath: path.join(resolved, '.agents', 'docs', 'workflows.md'),
  };
}

const { workflowsDir: WORKFLOWS_DIR, docPath: DOC_PATH } = resolveTargets();

/**
 * Escapes `*`/`_` so a glob like `audit-*` is not parsed as emphasis (MD037);
 * safe globally because descriptions put neither inside code spans.
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
    '[`SDLC.md`](https://github.com/dsj1984/mandrel/blob/main/docs/SDLC.md) — read that first to understand how the commands',
    'compose. This file is only for "which command does X?" lookups.',
    '',
    'Every command file lives at `.agents/workflows/<name>.md` and is projected',
    'into a flat `.claude/commands/` tree by `npm run sync:commands` (kept',
    'current at install time and on every `mandrel sync`/`update`) so it shows',
    'up as a bare `/<name>` slash command (e.g. `/mandrel-deliver`). The projection',
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
 * @param {string} [root]
 * @returns {{
 *   generated: string,
 *   original: string | null,
 *   root: string,
 *   docPath: string,
 * }}
 */
export function buildExpected(root) {
  const { root: resolvedRoot, workflowsDir, docPath } = resolveTargets(root);
  const catalog = buildCatalog(workflowsDir);
  const loopCatalog = buildLoopCatalog(workflowsDir);
  const generated = renderWorkflowsDoc(catalog, loopCatalog);
  const original = fs.existsSync(docPath)
    ? fs.readFileSync(docPath, 'utf8')
    : null;
  return { generated, original, root: resolvedRoot, docPath };
}

/**
 * @param {string[]} argv
 */
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      root: { type: 'string' },
    },
    allowPositionals: false,
  });

  const { generated, original, root, docPath } = buildExpected(values.root);
  const rel = path.relative(root, docPath).split(path.sep).join('/');

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
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, generated, 'utf8');
  Logger.info(`generate-workflows-doc: wrote ${rel}.`);
}

export { DOC_PATH, WORKFLOWS_DIR };

runAsCli(import.meta.url, main, {
  source: 'generate-workflows-doc',
  usage: {
    invocation:
      'node .agents/scripts/generate-workflows-doc.js [--check] [--root <dir>]',
    summary:
      'Regenerate the workflow catalog from .agents/workflows/. Writes only when the generated content differs.',
    flags: [
      [
        '--check',
        'Verify the doc is current and fail if stale; write nothing.',
      ],
      [
        '--root <dir>',
        "Render against another checkout's .agents/ tree instead of this one (test seam).",
      ],
    ],
  },
});
