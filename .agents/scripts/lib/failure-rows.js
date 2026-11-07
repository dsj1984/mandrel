/**
 * Picks the lines of a failing command's output worth quoting in a finding.
 * Handoff preflight, handoff post-capture and close share it, so the three
 * surfaces quote the same rows. One pass; memory is bounded by the cap.
 *
 * @module lib/failure-rows
 */

import { stripVTControlCharacters } from 'node:util';

const DEFAULT_MAX_ROWS = 10;

const MAX_LINE_CHARS = 200;

/** Indented lines kept after a failure marker, as its rows. */
const MARKER_FOLLOW_LINES = 3;

const GATE_PREFIX = /^\[[^\]]+\] /;
const FAILURE_MARKER = /[✖✗]/;
const BIOME_HEADER = /\s*━+$/;

/** Quote-worthy lines once normalised; the biome header is handled apart. */
const SIGNATURES = Object.freeze([
  /^Found \d+ (?:error|warning)s?\b/,
  /^- [a-z][a-z0-9-]*: FAIL \(/,
  /^↳ remedy:/,
  /^· /,
  /^! schema error/,
  /^Totals:/,
]);

/** A quality-preview per-file row: not the header, separator or placeholder. */
function isTableRow(line) {
  return (
    /^\|.*\|$/.test(line) &&
    !/^\|\s*file\s*\|/.test(line) &&
    !/^\|[\s|:-]+\|$/.test(line) &&
    !line.includes('_(no per-file regressions)_')
  );
}

/** @returns {{ raw: string, text: string }} prefix/ANSI-free line, raw keeps its indent. */
function normalise(line) {
  const raw = stripVTControlCharacters(line).replace(GATE_PREFIX, '');
  return { raw, text: raw.trim().slice(0, MAX_LINE_CHARS) };
}

/**
 * The quotable form of a line, or `null`; the second field says whether it
 * is a failure marker whose indented successors are its rows.
 */
function classify(text) {
  if (FAILURE_MARKER.test(text)) return { quote: text, marker: true };
  if (BIOME_HEADER.test(text)) {
    const quote = text.replace(BIOME_HEADER, '');
    return quote ? { quote, marker: false } : null;
  }
  if (SIGNATURES.some((re) => re.test(text)) || isTableRow(text)) {
    return { quote: text, marker: false };
  }
  return null;
}

/** A streaming collector: feed lines with `push`, read the quoted rows back. */
function createFailureRowCollector({ max = DEFAULT_MAX_ROWS } = {}) {
  const rows = [];
  const seen = new Set();
  let follow = 0;
  const add = (text) => {
    if (rows.length >= max || seen.has(text)) return;
    seen.add(text);
    rows.push(text);
  };
  return {
    push(line) {
      if (rows.length >= max) return;
      const { raw, text } = normalise(String(line));
      if (follow > 0 && /^\s+\S/.test(raw)) {
        follow -= 1;
        add(text);
        return;
      }
      follow = 0;
      const hit = text ? classify(text) : null;
      if (!hit) return;
      add(hit.quote);
      if (hit.marker) follow = MARKER_FOLLOW_LINES;
    },
    rows: () => [...rows],
  };
}

/**
 * The quoted rows of a whole output; empty means nothing parsed.
 *
 * @param {string} output
 * @param {{ max?: number }} [opts]
 * @returns {string[]}
 */
export function extractFailureRows(output, opts) {
  const collector = createFailureRowCollector(opts);
  for (const line of String(output ?? '').split(/\r?\n/)) collector.push(line);
  return collector.rows();
}

/** A finding's `: <row>; <row>` quote, `''` when nothing parsed. */
export function quoteFailureRows(output, opts) {
  const rows = extractFailureRows(output, opts);
  return rows.length > 0 ? `: ${rows.join('; ')}` : '';
}

/** Retains an opted-in gate's capped rows as its lines stream past `emit`. */
export function tapFailureRows(retain, emit) {
  if (!retain) return { tap: emit, rowsResult: () => ({}) };
  const rows = createFailureRowCollector();
  const tap = (line) => {
    rows.push(line);
    emit(line);
  };
  return { tap, rowsResult: () => ({ failureRows: rows.rows() }) };
}
