/**
 * docs-digest.js — a compact outline of `project.docsContextFiles` (path,
 * size, headings with line numbers, first `##` paragraph) so agents pull
 * full docs on demand instead of ingesting the whole set per Story.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readDocFiles } from './doc-reader.js';

/** `##`/`###` headings — the planning-context budget's section granularity. */
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

function byteLen(s) {
  if (s == null) return 0;
  return Buffer.byteLength(String(s), 'utf-8');
}

/**
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
 * First paragraph under a heading; '' when the section has no prose.
 *
 * @param {string[]} lines
 * @param {number} headingLine 1-based
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
 * Build the digest; missing files are skipped. `null` when nothing is
 * readable, so callers report a null `docsDigestPath` instead of an empty
 * file.
 *
 * @param {{ docsContextFiles?: string[], docsRoot?: string }} args
 * @returns {Promise<string|null>}
 */
export async function buildDocsDigest({ docsContextFiles, docsRoot } = {}) {
  const files = Array.isArray(docsContextFiles) ? docsContextFiles : [];
  if (files.length === 0) return null;

  const docs = await readDocFiles({ files, docsRoot });
  if (docs.length === 0) return null;

  const header = [
    '# Docs digest',
    '',
    'Per-run outline of the project docs context set. Each entry lists the',
    'file path, byte size, and its heading outline (with line numbers) plus',
    'the first paragraph under each `##` section. Read the full file on demand',
    'when a section looks relevant — do **not** ingest the whole set per Story.',
    '',
  ].join('\n');

  const sections = docs.map(renderDocSection).join('\n');
  return `${header}\n${sections}`.replace(/\n+$/, '\n');
}

/**
 * Build and write the digest (`null`, no write, when empty). Shared by the
 * deliver and planner surfaces; callers own path construction.
 *
 * @param {{ docsContextFiles?: string[], docsRoot?: string, outputPath: string }} args
 * @returns {Promise<{ digest: string, outputPath: string } | null>}
 */
export async function ensureDocsDigest({
  docsContextFiles,
  docsRoot,
  outputPath,
} = {}) {
  const digest = await buildDocsDigest({ docsContextFiles, docsRoot });
  if (digest == null) return null;

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, digest, 'utf-8');
  return { digest, outputPath };
}
