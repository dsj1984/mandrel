#!/usr/bin/env node
/**
 * .agents/scripts/generate-lifecycle-docs.js — Schema-backed lifecycle docs table
 *
 * Renders a bounded region inside `docs/LIFECYCLE.md` from every
 * `.agents/schemas/lifecycle/*.schema.json`. The region is delimited by:
 *
 *     <!-- BEGIN GENERATED:lifecycle-events -->
 *     ...generated table...
 *     <!-- END GENERATED:lifecycle-events -->
 *
 * Columns: | Event | Schema | Description | Required fields |
 *
 *   - Event             = schema filename minus `.schema.json`
 *   - Schema            = relative markdown link to the schema file
 *   - Description       = the schema's top-level `description` property
 *   - Required fields   = comma-joined list from the schema's `required` array
 *                         (rendered as inline code; "—" when empty/absent)
 *
 * Skips `README.md`. The `ledger-record.schema.json` file is a record
 * envelope rather than a lifecycle event, but to keep this generator
 * literal-schema driven we still emit a row for it — the surrounding doc
 * already calls out the distinction.
 *
 * Modes:
 *   (default)  — rewrites the bounded region in place.
 *   --check    — exits 0 when the on-disk region matches the freshly
 *                generated content, exits 1 with a diff hint otherwise.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, unrecoverable
 * failures surface via `throw new Error(...)` so `runAsCli` can map the
 * throw to `process.exit(1)` deterministically (no `Logger.fatal`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_DIR = path.join(PROJECT_ROOT, '.agents', 'schemas', 'lifecycle');
const DOC_PATH = path.join(PROJECT_ROOT, 'docs', 'LIFECYCLE.md');
const REGION_BEGIN = '<!-- BEGIN GENERATED:lifecycle-events -->';
const REGION_END = '<!-- END GENERATED:lifecycle-events -->';

/**
 * Read and parse every `*.schema.json` under the lifecycle schema dir, in
 * ASCII-sorted filename order. The sort is intentional — it produces a
 * stable diff regardless of the host filesystem's enumeration order, which
 * is what makes `--check` reliable across platforms.
 *
 * @param {string} dir Absolute path to the schema directory.
 * @returns {Array<{event:string, file:string, description:string, required:string[]}>}
 */
function readLifecycleSchemas(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Lifecycle schema directory not found: ${dir}`);
  }
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  if (entries.length === 0) {
    throw new Error(`No *.schema.json files found in ${dir}`);
  }
  return entries.map((file) => {
    const abs = path.join(dir, file);
    const raw = fs.readFileSync(abs, 'utf8');
    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse JSON schema ${file}: ${err.message}`);
    }
    const event = file.replace(/\.schema\.json$/, '');
    const description =
      typeof json.description === 'string' && json.description.trim().length > 0
        ? json.description.trim()
        : '';
    const required = Array.isArray(json.required) ? [...json.required] : [];
    return { event, file, description, required };
  });
}

/**
 * Escape pipe characters so they survive Markdown table cell parsing.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return text.replace(/\|/g, '\\|');
}

/**
 * Render the bounded-region body (the generated content between the two
 * comment markers, exclusive of the markers themselves).
 *
 * @param {ReturnType<typeof readLifecycleSchemas>} rows
 * @returns {string}
 */
function renderTable(rows) {
  const header = '| Event | Schema | Description | Required fields |';
  const sep = '| --- | --- | --- | --- |';
  const body = rows.map((row) => {
    const eventCell = `\`${row.event}\``;
    const schemaLink = `[\`${row.file}\`](../.agents/schemas/lifecycle/${row.file})`;
    const description = escapeCell(row.description || '—');
    const requiredCell =
      row.required.length === 0
        ? '—'
        : row.required.map((field) => `\`${field}\``).join(', ');
    return `| ${eventCell} | ${schemaLink} | ${description} | ${requiredCell} |`;
  });
  // Surround with blank lines so the markers + table read as a separate block.
  return ['', header, sep, ...body, ''].join('\n');
}

/**
 * Substitute the bounded region inside `original`. Throws if either marker
 * is missing, or if `BEGIN` appears after `END`. Idempotent — a re-run on
 * the same input yields byte-identical output.
 *
 * @param {string} original
 * @param {string} body Region body, already including leading/trailing blank
 *                      lines (as produced by `renderTable`).
 * @returns {string}
 */
function spliceRegion(original, body) {
  const beginIdx = original.indexOf(REGION_BEGIN);
  const endIdx = original.indexOf(REGION_END);
  if (beginIdx === -1) {
    throw new Error(
      `Missing region marker "${REGION_BEGIN}" in ${DOC_PATH}. ` +
        'Insert the marker pair before re-running the generator.',
    );
  }
  if (endIdx === -1) {
    throw new Error(
      `Missing region marker "${REGION_END}" in ${DOC_PATH}. ` +
        'Insert the marker pair before re-running the generator.',
    );
  }
  if (endIdx < beginIdx) {
    throw new Error(
      `Region markers out of order in ${DOC_PATH}: END appears before BEGIN.`,
    );
  }
  const before = original.slice(0, beginIdx + REGION_BEGIN.length);
  const after = original.slice(endIdx);
  return `${before}\n${body}\n${after}`;
}

/**
 * Build the canonical post-generation file content for `docs/LIFECYCLE.md`.
 *
 * @param {string} schemaDir
 * @param {string} docPath
 * @returns {{ generated: string, original: string }}
 */
function buildExpected(schemaDir, docPath) {
  if (!fs.existsSync(docPath)) {
    throw new Error(`Target doc not found: ${docPath}`);
  }
  const original = fs.readFileSync(docPath, 'utf8');
  const rows = readLifecycleSchemas(schemaDir);
  const body = renderTable(rows);
  const generated = spliceRegion(original, body);
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

  const { generated, original } = buildExpected(SCHEMA_DIR, DOC_PATH);

  if (values.check) {
    if (generated === original) {
      Logger.info(
        `generate-lifecycle-docs: ${path.relative(PROJECT_ROOT, DOC_PATH)} is up to date.`,
      );
      return;
    }
    const hint =
      `${path.relative(PROJECT_ROOT, DOC_PATH)} is out of date. ` +
      'Run `node .agents/scripts/generate-lifecycle-docs.js` to regenerate the bounded region.';
    throw new Error(hint);
  }

  if (generated === original) {
    Logger.info(
      `generate-lifecycle-docs: ${path.relative(PROJECT_ROOT, DOC_PATH)} already current — no write.`,
    );
    return;
  }
  fs.writeFileSync(DOC_PATH, generated, 'utf8');
  Logger.info(
    `generate-lifecycle-docs: wrote bounded region into ${path.relative(PROJECT_ROOT, DOC_PATH)}.`,
  );
}

export {
  buildExpected,
  REGION_BEGIN,
  REGION_END,
  readLifecycleSchemas,
  renderTable,
  spliceRegion,
};

runAsCli(import.meta.url, main, { source: 'generate-lifecycle-docs' });
