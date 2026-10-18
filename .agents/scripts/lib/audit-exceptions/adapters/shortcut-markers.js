/**
 * Deliberate-shortcut markers: `shortcut: <ceiling>, <trigger>` comments. The
 * trigger rides as the justification, so the shared classifier reads a named
 * trigger as `live`, a passed date as `expired`, a closed `until #N` as
 * `orphaned`, and a missing trigger as `unjustified`.
 *
 * @module lib/audit-exceptions/adapters/shortcut-markers
 */

import { insideString } from '../locate.js';
import { readText } from '../read.js';
import { makeRecord } from '../record.js';

const SCANNED_EXT_RE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|css|scss|html|py|go|rs|rb|java|kt|swift|cs|php|sh)$/;

const MARKER_RE = /(?:\/\/+|\/\*+|#+|<!--|^\s*\*)\s*shortcut:\s*(.*)$/g;

function parse(text) {
  const body = text.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
  const comma = body.indexOf(',');
  const ceiling = (comma === -1 ? body : body.slice(0, comma)).trim();
  const trigger = comma === -1 ? '' : body.slice(comma + 1).trim();
  // A bare date or `when #N` trigger gets the `until` lead the expiry and ticket readers key on.
  const bare = /^(?:when\s+)?(?:#\d|\d{4}-\d{2}-\d{2}\b)/.test(trigger);
  return { ceiling, trigger: bare ? `until ${trigger}` : trigger };
}

function fileRecords(ctx, file) {
  const records = [];
  (readText(ctx.root, file) ?? '').split('\n').forEach((line, i) => {
    const hit = [...line.matchAll(MARKER_RE)][0];
    if (!hit || insideString(line, hit.index)) return;
    const { ceiling, trigger } = parse(hit[1]);
    records.push(
      makeRecord({
        adapter: 'shortcut-markers',
        category: 'inline',
        surface: 'shortcut-marker',
        file,
        line: i + 1,
        target: ceiling,
        rule: trigger ? 'has-trigger' : 'no-trigger',
        justification: trigger || null,
        probe: trigger ? { verdict: 'live', basis: 'trigger-named' } : null,
      }),
    );
  });
  return records;
}

export const shortcutMarkers = Object.freeze({
  id: 'shortcut-markers',
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
