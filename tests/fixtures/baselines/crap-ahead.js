/**
 * A CRAP baseline stamped one scoring-semantics step ahead of the running
 * code, in the grouped `files` layout (no `rows[]`). The stamp is derived,
 * so the fixture stays ahead after the next bump.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { envelopeExtras } from '../../../.agents/scripts/lib/baselines/kinds/crap.js';

export const RUNNING_STAMP = envelopeExtras().scoringSemantics;
export const AHEAD_STAMP = RUNNING_STAMP.replace(
  /\d+$/,
  (n) => `${Number(n) + 1}`,
);

/** @returns {string} The ahead envelope's file text. */
export function aheadCrapBaselineText() {
  const envelope = JSON.parse(
    readFileSync(new URL('./crap-ahead-v5.json', import.meta.url), 'utf8'),
  );
  envelope.scoringSemantics = AHEAD_STAMP;
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Write the ahead envelope to `filePath`; returns its bytes. */
export function writeAheadCrapBaseline(filePath) {
  const text = aheadCrapBaselineText();
  writeFileSync(filePath, text);
  return text;
}
