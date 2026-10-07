/**
 * Tolerant readers for the `/audit-exceptions` engine. Every reader returns
 * `null` on an absent or unparseable file rather than throwing: a consumer's
 * malformed config is evidence to record, never a reason to abort the run.
 * Nothing here evaluates code — JS-format configs are read as text only.
 *
 * @module lib/audit-exceptions/read
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string|null}
 */
export function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Strip `//` and `/* *\/` comments plus trailing commas, outside strings, so a
 * JSONC config (`biome.jsonc`, `tsconfig.json`) parses with `JSON.parse`.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      i = lineEnd(text, i);
    } else if (ch === '/' && text[i + 1] === '*') {
      i = blockEnd(text, i);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

function lineEnd(text, start) {
  const nl = text.indexOf('\n', start);
  return nl === -1 ? text.length : nl;
}

function blockEnd(text, start) {
  const close = text.indexOf('*/', start + 2);
  return close === -1 ? text.length : close + 2;
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {any}
 */
export function readJsonc(root, rel) {
  const text = readText(root, rel);
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {any}
 */
export function readYaml(root, rel) {
  const text = readText(root, rel);
  if (text === null) return null;
  try {
    return yaml.load(text) ?? null;
  } catch {
    return null;
  }
}

/**
 * 1-based line of the first occurrence of `needle` in `text`, or 1 when it
 * does not occur — a record always carries a line a reader can open.
 *
 * @param {string|null} text
 * @param {string} needle
 * @returns {number}
 */
export function lineOf(text, needle) {
  if (!text) return 1;
  const at = text.indexOf(needle);
  if (at === -1) return 1;
  return text.slice(0, at).split('\n').length;
}
