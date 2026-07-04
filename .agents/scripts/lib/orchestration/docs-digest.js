/**
 * docs-digest.js — per-Epic docs digest builder (Story #4338).
 *
 * `/deliver` story sub-agents previously re-read every file in
 * `project.docsContextFiles` on every Story, re-paying the full docs payload
 * per child. This module produces a single **digest** — one compact markdown
 * outline per configured doc — that the parent threads into every child prompt
 * once. The digest gives each child enough shape (path, size, heading outline
 * with line numbers, and the first paragraph under each `##` section) to decide
 * which full files to pull on demand, instead of ingesting the whole set up
 * front.
 *
 * The heavy lifting of reading + normalizing doc bodies is delegated to
 * `doc-reader.js` (`readDocFiles`), keeping a single home for the fs read path.
 */

import { readDocFiles } from './doc-reader.js';

/**
 * Level-2 / level-3 markdown heading matcher. Mirrors the outline granularity
 * the planning-context budget already uses so the two surfaces agree on what a
 * "section" is.
 */
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

function byteLen(s) {
  if (s == null) return 0;
  return Buffer.byteLength(String(s), 'utf-8');
}

/**
 * Extract the heading outline (level + text + 1-based line number) from a
 * markdown body. Line numbers let a child jump straight to the section it
 * needs when it pulls the full file.
 *
 * @param {string} content
 * @returns {Array<{ level: number, text: string, line: number }>}
 */
function extractOutline(content) {
  if (!content) return [];
  const lines = String(content).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return out;
}

/**
 * The first non-empty paragraph that follows a given heading line, up to the
 * next heading or a blank-line paragraph break. Returns '' when the section
 * has no prose (e.g. a heading immediately followed by a sub-heading).
 *
 * @param {string[]} lines full doc split into lines
 * @param {number} headingLine 1-based line of the heading
 * @returns {string}
 */
function firstParagraphAfter(lines, headingLine) {
  const para = [];
  for (let i = headingLine; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING_RE.test(line)) break;
    if (line.trim() === '') {
      if (para.length > 0) break;
      continue;
    }
    para.push(line.trim());
  }
  return para.join(' ').trim();
}

/**
 * Render one doc's digest section: path + byte size, then a bulleted heading
 * outline where each `##` bullet carries the first paragraph beneath it.
 *
 * @param {{ path: string, content: string }} doc
 * @returns {string} markdown block
 */
function renderDocSection(doc) {
  const content = typeof doc.content === 'string' ? doc.content : '';
  const lines = content.split(/\r?\n/);
  const outline = extractOutline(content);
  const size = byteLen(content);

  const parts = [`### \`${doc.path}\` (${size} bytes)`, ''];
  if (outline.length === 0) {
    parts.push('_No `##`/`###` headings._', '');
    return parts.join('\n');
  }

  for (const h of outline) {
    const indent = h.level === 3 ? '  ' : '';
    parts.push(`${indent}- L${h.line} \`${'#'.repeat(h.level)}\` ${h.text}`);
    if (h.level === 2) {
      const para = firstParagraphAfter(lines, h.line);
      if (para) parts.push(`${indent}  ${para}`);
    }
  }
  parts.push('');
  return parts.join('\n');
}

/**
 * Build the per-Epic docs digest markdown from the configured docs context
 * files. Missing files are skipped silently (the read seam returns only the
 * files it could stat + read). Returns `null` when there is nothing to digest
 * — i.e. `docsContextFiles` is empty/unset — so callers surface a null
 * `docsDigestPath` rather than writing an empty file.
 *
 * @param {{ docsContextFiles?: string[], docsRoot?: string }} args
 * @returns {Promise<string|null>} the digest markdown, or null when there are
 *   no files to digest.
 */
export async function buildDocsDigest({ docsContextFiles, docsRoot } = {}) {
  const files = Array.isArray(docsContextFiles) ? docsContextFiles : [];
  if (files.length === 0) return null;

  const docs = await readDocFiles({ files, docsRoot });
  if (docs.length === 0) return null;

  const header = [
    '# Docs digest',
    '',
    'Per-Epic outline of the project docs context set. Each entry lists the',
    'file path, byte size, and its heading outline (with line numbers) plus',
    'the first paragraph under each `##` section. Read the full file on demand',
    'when a section looks relevant — do **not** ingest the whole set per Story.',
    '',
  ].join('\n');

  const sections = docs.map(renderDocSection).join('\n');
  return `${header}\n${sections}`.replace(/\n+$/, '\n');
}
