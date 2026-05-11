/**
 * Comment body renderer for the triage workflow.
 *
 * Kept as a pure function so the test suite can lock the rendered output
 * against fixtures without touching gh/network. The marker constant is
 * exported because both the renderer and the comment-lookup step need it
 * (the lookup keys on substring match against this exact string).
 */

import { sortPayloadsByOs } from './parse-test-output.js';

/**
 * Stable HTML marker used to key the triage comment. **Do not** change the
 * suffix `v1` without bumping the comment-finder logic in
 * `triage-ci-failure.js` — existing PRs in flight carry the old marker and
 * a renaming pass would orphan their comments.
 */
export const TRIAGE_MARKER = '<!-- ci-triage-comment v1 -->';

const MAX_LINE_LENGTH = 200;

/**
 * Truncate a single line of stderr output for embedding inside a fenced
 * code block. Long lines (e.g. JSON-encoded escomplex dumps) blow up the
 * comment height and obscure the actually-failing assertion; cap each line
 * and suffix `…` to make truncation visible.
 *
 * @param {string} line
 */
function truncateLine(line) {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

/**
 * Render the test-output section. Returns an empty string when no payload
 * has any anchored or fallback content (e.g. all artifacts missing).
 *
 * @param {Array<{ os: string|null, lines: string[], anchored: boolean }>} payloads
 */
function renderTestOutputSection(payloads) {
  const sorted = sortPayloadsByOs(payloads).filter((p) => p.lines.length > 0);
  if (sorted.length === 0) {
    return '_No test-output artifacts were available for this run._';
  }
  const blocks = sorted.map((p) => {
    const heading = p.os ? `**${p.os}**` : '**unknown runner**';
    const note = p.anchored
      ? ''
      : '\n_No failure marker matched; showing last lines of the artifact._\n';
    const body = p.lines.map(truncateLine).join('\n');
    return `${heading}${note}\n\n\`\`\`\n${body}\n\`\`\``;
  });
  return blocks.join('\n\n');
}

/**
 * Render the CRAP-regression table. Empty array → "no regressions" note.
 *
 * @param {Array<{
 *   file: string, method: string, startLine: number,
 *   cyclomatic: number, coverage: number, crap: number,
 *   baseline: number|null, kind: string
 * }>} regressions
 */
function renderCrapSection(regressions) {
  if (!regressions || regressions.length === 0) {
    return '_No CRAP regressions reported for this run._';
  }
  const header =
    '| File | Method (line) | CRAP | Baseline | Δ | Coverage | Cyclomatic | Kind |\n' +
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |';
  const rows = regressions.map((r) => {
    const baselineCell =
      r.baseline === null || r.baseline === undefined
        ? '—'
        : r.baseline.toFixed(2);
    const delta =
      r.baseline === null || r.baseline === undefined
        ? '—'
        : `+${(r.crap - r.baseline).toFixed(2)}`;
    const covPct = `${(r.coverage * 100).toFixed(0)}%`;
    return `| \`${r.file}\` | \`${r.method}\` (L${r.startLine}) | ${r.crap.toFixed(2)} | ${baselineCell} | ${delta} | ${covPct} | ${r.cyclomatic} | ${r.kind} |`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Build the full comment body for a triage comment. Pure — produces the
 * same string for the same inputs, including the trailing marker, so
 * idempotent PATCH calls can compare bodies byte-for-byte.
 *
 * @param {object} input
 * @param {string|number} input.runId
 * @param {string} [input.runUrl]
 * @param {Array<{ os: string|null, lines: string[], anchored: boolean }>} input.testOutputs
 * @param {Array<object>} input.crapRegressions
 */
export function renderTriageComment(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('renderTriageComment: input is required');
  }
  const { runId, runUrl, testOutputs = [], crapRegressions = [] } = input;
  if (runId === undefined || runId === null || runId === '') {
    throw new TypeError('renderTriageComment: runId is required');
  }

  const heading = '## CI failure triage';
  const intro = runUrl
    ? `Triage for failed run [${runId}](${runUrl}).`
    : `Triage for failed run \`${runId}\`.`;

  const testHeading = '### Failing test output (tail)';
  const testBody = renderTestOutputSection(testOutputs);

  const crapHeading = '### Top CRAP regressions';
  const crapBody = renderCrapSection(crapRegressions);

  const footer =
    '_This comment is regenerated on every CI re-run. ' +
    'See the run artifacts for full output._';

  return [
    TRIAGE_MARKER,
    heading,
    intro,
    testHeading,
    testBody,
    crapHeading,
    crapBody,
    footer,
  ].join('\n\n');
}
