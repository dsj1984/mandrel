/**
 * Inline suppression comments: biome, eslint, TypeScript, coverage, markdownlint
 * and prettier directives. Static reading cannot prove a suppression unused, so
 * these records settle on their justification; `--probe` asks each tool which
 * of them suppress nothing.
 *
 * @module lib/audit-exceptions/adapters/inline-suppressions
 */

import { readText } from '../read.js';
import { makeRecord } from '../record.js';

const SCANNED_EXT_RE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|css|scss|html)$/;

/** A directive only counts directly after a comment opener. */
const OPENER = String.raw`(?:\/\/+|\/\*+|<!--|^\s*\*)\s*`;

/** Each matcher: `re` over the text after the opener → `{ tool, rule, reason }`. */
const MATCHERS = Object.freeze([
  {
    re: /^biome-ignore(?:-all|-start)?\s+([^\s:]+)?\s*:?\s*(.*)$/,
    parse: (m) => ({ tool: 'biome', rule: m[1] ?? '*', reason: m[2] }),
  },
  {
    re: /^eslint-disable(?:-next-line|-line)?\b(.*?)(?:\s--\s(.*?))?\s*(?:\*\/.*)?$/,
    parse: (m) => ({ tool: 'eslint', rule: m[1].trim() || '*', reason: m[2] }),
  },
  {
    re: /^@ts-(expect-error|ignore|nocheck)\b\s*:?\s*(.*)$/,
    parse: (m) => ({ tool: 'typescript', rule: `@ts-${m[1]}`, reason: m[2] }),
  },
  {
    re: /^(c8|istanbul) ignore\s+(next|start|else|if|file)\b\s*(.*)$/,
    parse: (m) => ({
      tool: 'coverage',
      rule: `${m[1]}-ignore-${m[2]}`,
      reason: m[3],
    }),
  },
  {
    re: /^markdownlint-disable(?:-next-line|-line|-file)?\b\s*(.*?)\s*-->(.*)$/,
    parse: (m) => ({ tool: 'markdownlint', rule: m[1] || '*', reason: m[2] }),
  },
  {
    re: /^prettier-ignore\b(.*)$/,
    parse: (m) => ({ tool: 'prettier', rule: 'prettier-ignore', reason: m[1] }),
  },
]);

const OPENER_RE = new RegExp(OPENER, 'g');

/** True when an odd number of one quote kind precede `index` — inside a string. */
function insideString(line, index) {
  const before = line.slice(0, index);
  return ['"', "'", '`'].some((q) => before.split(q).length % 2 === 0);
}

function matchLine(line) {
  for (const opener of line.matchAll(OPENER_RE)) {
    const rest = line.slice(opener.index + opener[0].length);
    const hit = MATCHERS.find((m) => m.re.test(rest));
    if (!hit) continue;
    if (insideString(line, opener.index)) return null;
    return hit.parse(hit.re.exec(rest));
  }
  return null;
}

/** A pure comment line directly above, used when the directive carries no reason. */
function reasonAbove(lines, i) {
  const prev = lines[i - 1]?.trim() ?? '';
  if (!/^(?:\/\/|\/\*|\*|<!--)/.test(prev) || matchLine(prev)) return null;
  return prev.replace(/^(?:\/\/+|\/\*+|\*+|<!--)\s*|\s*(?:\*\/|-->)$/g, '');
}

function fileRecords(ctx, file) {
  const lines = (readText(ctx.root, file) ?? '').split('\n');
  const records = [];
  lines.forEach((line, i) => {
    const hit = matchLine(line);
    if (!hit) return;
    const reason =
      hit.reason?.replace(/\s*(?:\*\/|-->)\s*$/, '') || reasonAbove(lines, i);
    records.push(
      makeRecord({
        adapter: 'inline-suppressions',
        category: 'inline',
        surface: hit.tool,
        file,
        line: i + 1,
        target: hit.rule,
        rule: `${hit.tool}:${hit.rule}`,
        justification: reason,
      }),
    );
  });
  return records;
}

export const inlineSuppressions = Object.freeze({
  id: 'inline-suppressions',
  category: 'inline',
  applies: (ctx) =>
    ctx.scope.files.some((f) => SCANNED_EXT_RE.test(f))
      ? { applies: true, reason: 'source files present' }
      : { applies: false, reason: 'no scannable source files' },
  extract: (ctx) =>
    ctx.scope.files
      .filter((f) => SCANNED_EXT_RE.test(f))
      .flatMap((f) => fileRecords(ctx, f)),
});
