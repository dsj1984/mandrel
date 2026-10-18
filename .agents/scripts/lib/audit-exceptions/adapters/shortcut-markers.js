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
import { sourceScanAdapter } from './source-scan.js';

const SCANNED_EXT_RE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|css|scss|html|py|go|rs|rb|java|kt|swift|cs|php|sh)$/;

const MARKER_RE = /(?:\/\/+|\/\*+|#+|<!--|^\s*\*)\s*shortcut:\s*(.*)$/g;

function stripCloser(text) {
  return text.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
}

/** A bare date or `when #N` trigger gets the `until` lead the expiry and ticket readers key on. */
function withUntilLead(trigger) {
  return /^(?:when\s+)?(?:#\d|\d{4}-\d{2}-\d{2}\b)/.test(trigger)
    ? `until ${trigger}`
    : trigger;
}

function parse(text) {
  const body = stripCloser(text);
  const comma = body.indexOf(',');
  if (comma === -1) return { ceiling: body, trigger: '' };
  return {
    ceiling: body.slice(0, comma).trim(),
    trigger: withUntilLead(body.slice(comma + 1).trim()),
  };
}

function markerRecord(file, line, { ceiling, trigger }) {
  return makeRecord({
    adapter: 'shortcut-markers',
    category: 'inline',
    surface: 'shortcut-marker',
    file,
    line,
    target: ceiling,
    rule: trigger ? 'has-trigger' : 'no-trigger',
    justification: trigger || null,
    probe: trigger ? { verdict: 'live', basis: 'trigger-named' } : null,
  });
}

function fileRecords(ctx, file) {
  const records = [];
  (readText(ctx.root, file) ?? '').split('\n').forEach((line, i) => {
    const hit = [...line.matchAll(MARKER_RE)][0];
    if (hit && !insideString(line, hit.index)) {
      records.push(markerRecord(file, i + 1, parse(hit[1])));
    }
  });
  return records;
}

export const shortcutMarkers = sourceScanAdapter({
  id: 'shortcut-markers',
  extRe: SCANNED_EXT_RE,
  fileRecords,
});
