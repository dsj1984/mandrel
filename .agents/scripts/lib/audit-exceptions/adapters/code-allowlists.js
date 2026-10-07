/**
 * Hand-maintained allowlists in code: an array or `Set` literal bound to a
 * name that says "these are exempt" (`KNOWN_HELP_GAPS`, `EXEMPT_*`,
 * `*_ALLOWLIST`, `QUARANTINED_*`, …). Enumerations and traversal config
 * (`KNOWN_KINDS`, `ALLOWED_SEVERITIES`, `SKIP_DIRS`) are not exemptions and are
 * not read. One record per string entry, justified by its own trailing comment
 * or else the declaration's doc comment; an entry naming a repo path that no
 * longer exists is `dead`.
 *
 * @module lib/audit-exceptions/adapters/code-allowlists
 */

import { readText } from '../read.js';
import { makeRecord } from '../record.js';

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

const NAME_ALTERNATIVES = [
  'KNOWN_[A-Z0-9_]*(?:GAPS?|FAILURES?|FAILING|BROKEN|ISSUES?|VIOLATIONS?|EXCEPTIONS?|DEBT|LEAKS?|OFFENDERS?|DRIFT)',
  '(?:EXEMPT(?:ED|IONS?)?|QUARANTINED?|GRANDFATHER(?:ED)?|WAIVED|WAIVERS?)_[A-Z0-9_]+',
  '[A-Z0-9_]+_(?:ALLOWLIST|ALLOW_LIST|EXEMPT(?:ED|IONS?)?|EXCEPTIONS|WAIVERS?|GRANDFATHERED|QUARANTINED?)',
].map((alt) => `(?:${alt})`);

/** Cheap whole-file prefilter. */
const NAME_RE = new RegExp(NAME_ALTERNATIVES.join('|'));
const EXACT_NAME_RE = new RegExp(
  ['^(?:', NAME_ALTERNATIVES.join('|'), ')$'].join(''),
);

const DECL_RE =
  /(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(?:Object\.freeze\(\s*)?(?:new Set\(\s*)?\[/;
const ENTRY_RE = /(['"])((?:(?!\1).)+)\1/g;
const PATH_LIKE_RE = /^[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]+$/;

/**
 * @param {string[]} lines
 * @param {number} start - index of the declaration line.
 * @returns {number} index of the line closing the literal.
 */
function literalEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const code = lines[i].replace(/\/\/.*$/, '');
    depth +=
      (code.match(/\[/g) ?? []).length - (code.match(/\]/g) ?? []).length;
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

const COMMENT_LINE_RE = /^(?:\/\/|\/\*|\*)/;

/** The contiguous comment block directly above the declaration line. */
function docComment(lines, declIndex) {
  const block = [];
  for (
    let i = declIndex - 1;
    i >= 0 && COMMENT_LINE_RE.test(lines[i].trim());
    i -= 1
  ) {
    block.unshift(lines[i].trim().replace(/^(?:\/\/+|\/\*+|\*+\/?)\s*/, ''));
  }
  return block.join(' ').trim() || null;
}

/** The trailing `//` comment on an entry line, or a pure comment line above. */
function reasonFor(lines, i) {
  const trailing = /\/\/\s*(.*)$/.exec(lines[i])?.[1];
  if (trailing) return trailing;
  const prev = lines[i - 1]?.trim() ?? '';
  return /^\/\//.test(prev) ? prev.replace(/^\/\/+\s*/, '') : null;
}

function entryProbe(ctx, entry) {
  if (!PATH_LIKE_RE.test(entry)) return null;
  return ctx.scope.fileSet.has(entry)
    ? { verdict: 'live', basis: 'path-exists' }
    : { verdict: 'dead', basis: 'path-missing' };
}

function entryRecords(ctx, file, name, lines, from, to) {
  const declReason = docComment(lines, from);
  const records = [];
  for (let i = from; i <= to; i += 1) {
    const code = i === from ? lines[i].slice(lines[i].indexOf('[')) : lines[i];
    for (const m of code.replace(/\/\/.*$/, '').matchAll(ENTRY_RE)) {
      records.push(
        makeRecord({
          adapter: 'code-allowlists',
          category: 'allowlist',
          surface: 'source',
          file,
          line: i + 1,
          target: m[2],
          rule: name,
          justification:
            (i === from ? null : reasonFor(lines, i)) ?? declReason,
          probe: entryProbe(ctx, m[2]),
        }),
      );
    }
  }
  return records;
}

function fileRecords(ctx, file) {
  const text = readText(ctx.root, file) ?? '';
  if (!NAME_RE.test(text)) return [];
  const lines = text.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const decl = DECL_RE.exec(lines[i]);
    if (!decl || !EXACT_NAME_RE.test(decl[1])) continue;
    const end = literalEnd(lines, i);
    records.push(...entryRecords(ctx, file, decl[1], lines, i, end));
    i = end;
  }
  return records;
}

export const codeAllowlists = Object.freeze({
  id: 'code-allowlists',
  category: 'allowlist',
  applies: (ctx) =>
    ctx.scope.files.some((f) => SOURCE_EXT_RE.test(f))
      ? { applies: true, reason: 'source files present' }
      : { applies: false, reason: 'no JS/TS source files' },
  extract: (ctx) =>
    ctx.scope.files
      .filter((f) => SOURCE_EXT_RE.test(f))
      .flatMap((f) => fileRecords(ctx, f)),
});
