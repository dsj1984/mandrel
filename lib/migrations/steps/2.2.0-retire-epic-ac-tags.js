// lib/migrations/steps/2.2.0-retire-epic-ac-tags.js
/**
 * Strip the inert, taxonomy-violating `@epic-<id>-ac-N` tags from consumer
 * feature files; a tag line left empty is dropped, everything else is kept
 * byte-for-byte, and untouched files are never rewritten.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Mirrors `bdd-runner-detect.js`: `lib/` must not import the `.agents/` payload.
 */
const CANONICAL_FEATURE_ROOTS = Object.freeze([
  'tests/features',
  'features',
  'test/features',
]);

const EPIC_AC_TAG_RE = /@epic-\d+-ac-\d+/;

const TAG_LINE_RE = /^(\s*)(@\S+(?:\s+@\S+)*)\s*$/;

/**
 * @param {string} root
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string[]}
 */
function collectFeatureFiles(root, fsImpl = nodeFs) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.feature')) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

/**
 * @param {unknown} ctx
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string[]}
 */
function resolveFeatureFiles(ctx, fsImpl = nodeFs) {
  const projectRoot = ctx?.projectRoot ?? process.cwd();
  return CANONICAL_FEATURE_ROOTS.flatMap((root) =>
    collectFeatureFiles(path.join(projectRoot, root), fsImpl),
  );
}

/**
 * @param {string} content
 * @returns {string}
 */
function stripEpicAcTags(content) {
  if (!EPIC_AC_TAG_RE.test(content)) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    const match = line.match(TAG_LINE_RE);
    if (!match || !EPIC_AC_TAG_RE.test(line)) {
      out.push(line);
      continue;
    }
    const [, indent, tagBlock] = match;
    const kept = tagBlock
      .split(/\s+/)
      .filter((tag) => !EPIC_AC_TAG_RE.test(tag));
    if (kept.length === 0) continue;
    out.push(`${indent}${kept.join(' ')}`);
  }
  return out.join(newline);
}

export const retireEpicAcTags = {
  version: '2.2.0',
  description:
    'strip retired @epic-<id>-ac-N Gherkin AC tags from feature files ' +
    '(their reconciler consumer was deleted in the v2 Epic removal)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    return resolveFeatureFiles(ctx, fsImpl).some((file) => {
      try {
        return EPIC_AC_TAG_RE.test(fsImpl.readFileSync(file, 'utf8'));
      } catch {
        return false;
      }
    });
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    for (const file of resolveFeatureFiles(ctx, fsImpl)) {
      /** @type {string} */
      let content;
      try {
        content = fsImpl.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const stripped = stripEpicAcTags(content);
      if (stripped !== content) {
        fsImpl.writeFileSync(file, stripped);
      }
    }
  },
};
