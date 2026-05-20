import { selectSlowestEntries } from './parse-tap.js';

/**
 * @param {import('./parse-tap.js').TapProfile} profile
 * @param {{ topN?: number, wallDurationMs?: number | null }} [opts]
 * @returns {string}
 */
export function renderProfileReport(profile, opts = {}) {
  const topN = opts.topN ?? 20;
  const slowest = selectSlowestEntries(profile.entries, topN);
  const totalSec = (opts.wallDurationMs ?? profile.totalDurationMs ?? 0) / 1000;
  const lines = [
    'Mandrel test profile summary',
    '===========================',
    '',
    `Total duration: ${totalSec.toFixed(3)}s`,
    `Tests: ${profile.testCount ?? '—'}`,
    `Suites: ${profile.suiteCount ?? '—'}`,
    `Timed entries parsed: ${profile.entries.length}`,
    '',
    `Top ${topN} slowest (tests and suites):`,
    '',
  ];

  if (slowest.length === 0) {
    lines.push('  (no timed entries found in TAP output)');
  } else {
    for (const [idx, row] of slowest.entries()) {
      const kindLabel = row.kind === 'suite' ? 'suite' : 'test';
      const seconds = (row.durationMs / 1000).toFixed(3);
      lines.push(
        `${String(idx + 1).padStart(2)}. [${kindLabel.padEnd(5)}] ${seconds}s  ${row.path}`,
      );
    }
  }

  lines.push('');
  lines.push(
    'Notes: suite rows are parent describe blocks; test rows are leaf cases.',
  );
  lines.push(
    'Compare before/after optimizations using the same command on the same machine.',
  );
  return `${lines.join('\n')}\n`;
}
