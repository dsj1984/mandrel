// lib/migrations/steps/2.2.0-retire-epic-ac-tags.js
/**
 * Story #4604 — strip the retired `@epic-<id>-ac-N` Gherkin AC tag namespace
 * from consumer feature files.
 *
 * The v2 Epic removal deleted `acceptance-spec-reconciler.js`, the only
 * consumer of the namespaced per-Epic AC tags, and the `/plan` authoring
 * prompt no longer mandates them. Surviving tags in consumer `.feature`
 * files are inert and violate the gherkin-standards tag taxonomy's
 * no-ad-hoc-tags rule, so this step removes them: each `@epic-<digits>-ac-<digits>`
 * token is deleted from tag lines, a tag line left with no tags is dropped
 * entirely, and every other tag and line is preserved byte-for-byte. Files
 * with no stale tags are never rewritten.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Mirror of `CANONICAL_FEATURE_ROOTS` in
 * `.agents/scripts/lib/bdd-runner-detect.js`. Duplicated deliberately:
 * `lib/` runs from the installed npm package inside a consumer project and
 * must not import from the materialized `.agents/` payload.
 */
const CANONICAL_FEATURE_ROOTS = Object.freeze([
  'tests/features',
  'features',
  'test/features',
]);

const EPIC_AC_TAG_RE = /@epic-\d+-ac-\d+/;

/**
 * A Gherkin tag line: optional indentation followed by one or more
 * whitespace-separated `@tag` tokens and nothing else.
 */
const TAG_LINE_RE = /^(\s*)(@\S+(?:\s+@\S+)*)\s*$/;

/**
 * Recursively collect `.feature` file paths under `root`.
 *
 * @param {string} root
 * @param {typeof nodeFs} fsImpl
 * @returns {string[]}
 */
function collectFeatureFiles(root, fsImpl) {
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
 * @param {typeof nodeFs} fsImpl
 * @returns {string[]} Absolute paths of every `.feature` file under the
 *   canonical feature roots that exist in the consumer tree.
 */
function resolveFeatureFiles(ctx, fsImpl) {
  const projectRoot = ctx?.projectRoot ?? process.cwd();
  return CANONICAL_FEATURE_ROOTS.flatMap((root) =>
    collectFeatureFiles(path.join(projectRoot, root), fsImpl),
  );
}

/**
 * Strip retired `@epic-<id>-ac-<n>` tokens from one file's content.
 * Only tag lines are touched; a tag line whose every tag was retired is
 * dropped. Returns the original string when nothing matched.
 *
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
   * @returns {boolean}
   */
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
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
   * @returns {void}
   */
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
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
