/**
 * Parse Node.js `node --test --test-reporter tap` output into structured
 * timing rows plus footer aggregates.
 */

const SUBTEST_RE = /^(\s*)# Subtest:\s*(.+)$/;
const RESULT_RE = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(.+)$/;
const DURATION_RE = /^\s*duration_ms:\s*([\d.]+)/;
const FOOTER_TESTS_RE = /^# tests\s+(\d+)/;
const FOOTER_SUITES_RE = /^# suites\s+(\d+)/;
const FOOTER_DURATION_RE = /^# duration_ms\s+([\d.]+)/;

/**
 * @typedef {'test' | 'suite'} TapEntryKind
 * @typedef {{
 *   kind: TapEntryKind,
 *   name: string,
 *   path: string,
 *   durationMs: number,
 * }} TapTimingEntry
 * @typedef {{
 *   totalDurationMs: number | null,
 *   testCount: number | null,
 *   suiteCount: number | null,
 *   entries: TapTimingEntry[],
 * }} TapProfile
 */

/**
 * @param {string} tapText
 * @returns {TapProfile}
 */
export function parseTapOutput(tapText) {
  const lines = tapText.replace(/\r\n/g, '\n').split('\n');
  const suiteStack = [];
  const entries = [];
  let pending = null;
  let totalDurationMs = null;
  let testCount = null;
  let suiteCount = null;

  for (const line of lines) {
    const subtest = line.match(SUBTEST_RE);
    if (subtest) {
      const depth = Math.floor(subtest[1].length / 4);
      const name = subtest[2].trim();
      suiteStack.length = depth;
      suiteStack[depth] = name;
      continue;
    }

    const result = line.match(RESULT_RE);
    if (result) {
      pending = {
        depth: Math.floor(result[1].length / 4),
        name: result[3].trim(),
        kind: null,
        durationMs: null,
      };
      continue;
    }

    if (pending) {
      const duration = line.match(DURATION_RE);
      if (duration) {
        pending.durationMs = Number(duration[1]);
        continue;
      }
      if (line.trim() === "type: 'test'") {
        pending.kind = 'test';
        continue;
      }
      if (line.trim() === "type: 'suite'") {
        pending.kind = 'suite';
        continue;
      }
      if (line.trim() === '---') {
        continue;
      }
      if (line.trim() === '...') {
        if (pending.durationMs != null && pending.kind) {
          flushPending();
        }
        continue;
      }
    }

    const footerTests = line.match(FOOTER_TESTS_RE);
    if (footerTests) {
      testCount = Number(footerTests[1]);
      continue;
    }
    const footerSuites = line.match(FOOTER_SUITES_RE);
    if (footerSuites) {
      suiteCount = Number(footerSuites[1]);
      continue;
    }
    const footerDuration = line.match(FOOTER_DURATION_RE);
    if (footerDuration) {
      totalDurationMs = Number(footerDuration[1]);
    }
  }

  if (pending?.durationMs != null && pending.kind) {
    flushPending();
  }

  return {
    totalDurationMs,
    testCount,
    suiteCount,
    entries,
  };

  function flushPending() {
    const pathParts = suiteStack.slice(0, pending.depth).concat(pending.name);
    entries.push({
      kind: pending.kind,
      name: pending.name,
      path: pathParts.join(' › '),
      durationMs: pending.durationMs,
    });
    pending = null;
  }
}

/**
 * @param {TapTimingEntry[]} entries
 * @param {number} [topN=20]
 * @returns {TapTimingEntry[]}
 */
export function selectSlowestEntries(entries, topN = 20) {
  return [...entries]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, topN);
}
