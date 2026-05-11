/**
 * Pure parser for `test-output.txt` artifacts uploaded by `.github/workflows/ci.yml`.
 *
 * Each `validate` matrix job (ubuntu/windows × node 22) tees the combined
 * stdout+stderr of `npm run test:coverage` into a file that the workflow
 * uploads as `test-results-<os>-node-<v>/test-output.txt`. On failure, the
 * tail of that file contains the diagnostic the developer actually needs:
 * the failing assertion, the coverage-gate violation line, or the
 * unhandled rejection that aborted the run.
 *
 * The triage workflow has no execution context — only the artifact text —
 * so the parser must:
 *
 *   1. Be entirely pure (no I/O, no env reads). All inputs are arguments,
 *      all outputs are return values. Callers handle filesystem.
 *   2. Cope with both Unix and Windows line endings. The Windows runner
 *      writes CRLF; the Linux runner writes LF; the artifact upload step
 *      does not normalize.
 *   3. Walk backwards from EOF rather than scan the full buffer. Node's
 *      coverage gate, the test runner, and escomplex all dump multi-MB
 *      tails in failure modes, and the comment only needs the *last*
 *      ~30 lines anchored at a failure marker.
 *
 * The list of failure markers below is deliberately small: anything more
 * elaborate would couple this parser to specific upstream message formats
 * that have already churned twice (Node 20 → 22 reformatted `not ok`
 * output; the c8 0.x → 1.x coverage-threshold report changed wording).
 * The current set covers node:test, the coverage gate, the maintainability
 * gate, and the CRAP gate — the four producers that actually fail CI on
 * this repo.
 */

/**
 * Failure-marker regexes, in priority order. The *last* match in the file
 * wins (i.e. we anchor on the most recent failure, not the first).
 *
 * Each entry is matched line-by-line against trimmed line content so
 * leading whitespace from indented summary blocks does not throw the
 * anchor off.
 */
export const FAILURE_MARKERS = Object.freeze([
  /^not ok\b/, // node:test TAP-style failed assertion
  /^# fail\s+\d+/, // node:test summary "# fail 3" line
  /^✖\s/, // node:test pretty reporter ✖
  /^FAIL\b/, // generic FAIL banner
  /coverage threshold .* not met/i, // c8 coverage gate failure
  /maintainability .* regression/i, // .agents/scripts/check-maintainability.js
  /CRAP .* regression/i, // .agents/scripts/check-crap.js
  /Error: .+/, // unhandled top-level error
]);

/**
 * Normalize a raw artifact buffer to an array of LF-terminated lines.
 *
 * Handles CRLF (Windows runner), LF (Linux runner), and a stray trailing
 * empty line that `tee` produces when its input does not end with a
 * newline.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function normalizeLines(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('normalizeLines: raw must be a string');
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  // Drop a single trailing empty line (the artifact's terminating newline).
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Locate the index of the *last* line matching any failure marker.
 *
 * Returns `-1` if no marker matched. Callers fall back to "last N lines
 * of the file" in that case rather than rejecting the artifact outright —
 * the artifact is uploaded `if: always()` so a green run produces a file
 * with no markers, and the triage step is gated upstream on
 * `conclusion == 'failure'` anyway.
 *
 * @param {string[]} lines
 * @returns {number}
 */
export function findLastFailureMarker(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError('findLastFailureMarker: lines must be an array');
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    for (const marker of FAILURE_MARKERS) {
      if (marker.test(trimmed)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Extract the last ~`tailLines` lines anchored at the most recent failure
 * marker. The returned slice spans `[max(0, anchor - tailLines + 1), anchor]`
 * inclusive — i.e. the marker itself is the last line of the slice so the
 * reader sees the failing assertion at the bottom of the comment block.
 *
 * When no marker is present, returns the trailing `tailLines` lines.
 *
 * @param {string} raw
 * @param {{ tailLines?: number }} [opts]
 * @returns {{ os: string|null, lines: string[], anchored: boolean }}
 */
export function parseTestOutput(raw, opts = {}) {
  const tailLines = Number.isInteger(opts.tailLines) ? opts.tailLines : 30;
  if (tailLines <= 0) {
    throw new RangeError('parseTestOutput: tailLines must be > 0');
  }
  const lines = normalizeLines(raw);
  const anchor = findLastFailureMarker(lines);

  let slice;
  let anchored;
  if (anchor === -1) {
    slice = lines.slice(Math.max(0, lines.length - tailLines));
    anchored = false;
  } else {
    const start = Math.max(0, anchor - tailLines + 1);
    slice = lines.slice(start, anchor + 1);
    anchored = true;
  }

  return { os: opts.os ?? null, lines: slice, anchored };
}

/**
 * Combine per-OS parsed payloads into a stable ordering. Linux first, then
 * Windows, then anything else alphabetically — the ordering is load-bearing
 * for the rendered comment so two re-runs with the same artifacts produce
 * the same body byte-for-byte.
 *
 * @param {Array<{ os: string|null, lines: string[], anchored: boolean }>} payloads
 * @returns {Array<{ os: string|null, lines: string[], anchored: boolean }>}
 */
export function sortPayloadsByOs(payloads) {
  if (!Array.isArray(payloads)) {
    throw new TypeError('sortPayloadsByOs: payloads must be an array');
  }
  const rank = (os) => {
    if (!os) return 99;
    if (/ubuntu|linux/i.test(os)) return 0;
    if (/windows/i.test(os)) return 1;
    if (/mac|darwin/i.test(os)) return 2;
    return 3;
  };
  return [...payloads].sort((a, b) => {
    const ra = rank(a.os);
    const rb = rank(b.os);
    if (ra !== rb) return ra - rb;
    return String(a.os ?? '').localeCompare(String(b.os ?? ''));
  });
}
