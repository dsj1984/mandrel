/**
 * mandrel-catalog.js
 *
 * Walks `.agents/workflows/*.md` (top-level only — `helpers/` are
 * path-included modules, not slash commands) and produces the
 * Mandrel-owned slash-command catalog.
 *
 * This is the canonical catalog backend. The consumer-shipped
 * `.agents/docs/workflows.md` is generated from it by
 * `generate-workflows-doc.js`, and `npm run docs:check` gates that doc
 * against drift — same source-of-truth contract as
 * `sync-claude-commands.js`, just one layer up (catalog of what's
 * synced, not the sync itself). The retired `mandrel` discoverability
 * command used to render this catalog live; Story #3708 replaced it
 * with the gated, generated `workflows.md` so the catalog is shipped
 * and drift-checked rather than ephemeral.
 *
 * Pure functions only: no GitHub I/O, no file writes, no provider
 * factory. Callers (the doc generator, the unit test) pass an
 * absolute path to a workflows directory in; the function returns a
 * sorted array of `{ name, description }` entries plus a
 * `renderCatalog()` helper that produces a human-readable markdown
 * bullet list.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a workflow markdown file's YAML frontmatter and return its
 * `description:` field, normalized to a single-line string.
 *
 * Handles both the inline form (`description: foo bar`) and the
 * YAML folded-block form (`description: >-` followed by indented
 * continuation lines). Both forms appear in the live workflow set —
 * see `.agents/workflows/signals.md` (folded) vs.
 * `.agents/workflows/agents-bootstrap-github.md` (inline).
 *
 * Returns `null` if the file has no frontmatter or no `description:`
 * key. Returns the trimmed, whitespace-collapsed string otherwise.
 *
 * @param {string} source — full file contents.
 * @returns {string | null}
 */
export function extractDescription(source) {
  if (typeof source !== 'string') return null;
  // Frontmatter must be the first block. Match `---\n...\n---` at
  // the start of the file; tolerate a leading BOM.
  const trimmed = source.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = trimmed.slice(4, end);
  const lines = block.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = /^description:\s*(.*)$/i.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const rest = match[1].trim();
    // Folded / literal block forms: `>-`, `>`, `|`, `|-`. The actual
    // value follows on subsequent indented lines.
    if (/^[>|][-+]?\s*$/.test(rest) || rest === '') {
      const collected = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        // Stop on the next top-level key (column-0 alphanumeric +
        // colon) — that's the next frontmatter entry.
        if (/^[A-Za-z][\w-]*\s*:/.test(next)) break;
        // Blank line inside a folded block is permissible; keep
        // collecting until the next top-level key.
        collected.push(next.trim());
        j += 1;
      }
      const joined = collected.join(' ').replace(/\s+/g, ' ').trim();
      return joined.length > 0 ? joined : null;
    }
    // Inline form.
    return rest.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * Heuristic: treat a description as "vague" when it carries no
 * information beyond the workflow's own name. Callers can use this to
 * nudge the maintainer when a description needs tightening — it does
 * **not** block the catalog from rendering. The
 * description-frontmatter audit pass (Task #1619 acceptance) is a
 * one-time sweep; this helper exists so the audit doesn't silently
 * regress later.
 *
 * @param {string | null} description
 * @returns {boolean}
 */
export function isVagueDescription(description) {
  if (!description) return true;
  // Fewer than 30 characters of substance is suspicious for a
  // discoverability menu entry.
  if (description.trim().length < 30) return true;
  return false;
}

/**
 * Build the Mandrel-owned catalog from an on-disk workflows directory.
 *
 * @param {string} workflowsDir — absolute path to `.agents/workflows/`.
 * @returns {Array<{ name: string, description: string | null, vague: boolean }>}
 */
export function buildCatalog(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) {
    throw new Error(
      `mandrel-catalog: workflows directory not found: ${workflowsDir}`,
    );
  }
  const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
  const catalog = [];
  for (const entry of entries) {
    // Only top-level .md files — `helpers/` is intentionally not in
    // the runnable catalog (mirrors `sync-claude-commands.js`'s
    // `isTopLevelWorkflow` filter).
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'README.md') continue;
    const filePath = path.join(workflowsDir, entry.name);
    const source = fs.readFileSync(filePath, 'utf8');
    const description = extractDescription(source);
    catalog.push({
      name: entry.name.replace(/\.md$/, ''),
      description,
      vague: isVagueDescription(description),
    });
  }
  catalog.sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}

/**
 * Render the catalog as a plain-markdown bullet list. Kept as a
 * lightweight alternative rendering of the same catalog backend that
 * `generate-workflows-doc.js` renders into the shipped
 * `.agents/docs/workflows.md` table.
 *
 * @param {Array<{ name: string, description: string | null, vague: boolean }>} catalog
 * @returns {string}
 */
export function renderCatalog(catalog) {
  if (catalog.length === 0) {
    return '# Mandrel command catalog\n\n_(no workflows found)_\n';
  }
  const rows = catalog.map((entry) => {
    const desc = entry.description ?? '_(no description)_';
    const flag = entry.vague ? ' ⚠️ vague' : '';
    return `- **/${entry.name}** — ${desc}${flag}`;
  });
  return [
    '# Mandrel command catalog',
    '',
    `Source of truth: \`.agents/workflows/\` (${catalog.length} commands).`,
    'Auto-generated by `.agents/scripts/lib/mandrel-catalog.js`.',
    '',
    ...rows,
    '',
  ].join('\n');
}
