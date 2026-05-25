/**
 * Minimal TAP parser specialised for `node --test --test-reporter tap` output.
 * Extracts top-level subtests (file-level) pass/fail. The Node test runner
 * emits one top-level `# Subtest: <path>` per file followed eventually by
 * `ok N - <path>` or `not ok N - <path>` at indent depth 0.
 *
 * Returns a Map keyed by the subtest name, value `'pass' | 'fail'`. Failures
 * collect the failing leaf-test names for diagnostic surfacing.
 *
 * @typedef {{ status: 'pass' | 'fail', failingTests: string[] }} TopLevelResult
 *
 * @param {string} tapText
 * @returns {Map<string, TopLevelResult>}
 */
export function parseSuiteTap(tapText) {
  const out = new Map();
  const lines = tapText.replace(/\r\n/g, '\n').split('\n');
  let currentTop = null;
  const failingLeavesByTop = new Map();

  for (const line of lines) {
    const subtestMatch = line.match(/^(\s*)# Subtest:\s*(.+)$/);
    if (subtestMatch) {
      const indent = subtestMatch[1].length;
      if (indent === 0) {
        currentTop = subtestMatch[2].trim();
        if (!failingLeavesByTop.has(currentTop)) {
          failingLeavesByTop.set(currentTop, []);
        }
      }
      continue;
    }
    const resultMatch = line.match(/^(\s*)(ok|not ok)\s+\d+\s+-\s+(.+)$/);
    if (!resultMatch) continue;
    const indent = resultMatch[1].length;
    const verdict = resultMatch[2];
    const name = resultMatch[3].trim();

    if (indent === 0) {
      const status = verdict === 'ok' ? 'pass' : 'fail';
      const failing = failingLeavesByTop.get(name) ?? [];
      out.set(name, { status, failingTests: failing });
      continue;
    }
    if (verdict === 'not ok' && currentTop) {
      const arr = failingLeavesByTop.get(currentTop);
      if (arr) arr.push(name);
    }
  }
  return out;
}

/**
 * Parse a single-file `node --test` TAP run and return whether the file as a
 * whole passed plus the list of failing leaf-test names. The single-file run
 * has no top-level file subtest wrapper, so we look at the `# tests`/`# pass`
 * footer plus the deepest `not ok` entries.
 *
 * @param {string} tapText
 * @param {number} exitCode
 * @returns {{ status: 'pass' | 'fail', failingTests: string[] }}
 */
export function parseSingleFileTap(tapText, exitCode) {
  const lines = tapText.replace(/\r\n/g, '\n').split('\n');
  const failing = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)not ok\s+\d+\s+-\s+(.+)$/);
    if (!m) continue;
    failing.push(m[2].trim());
  }
  return {
    status: exitCode === 0 ? 'pass' : 'fail',
    failingTests: failing,
  };
}
