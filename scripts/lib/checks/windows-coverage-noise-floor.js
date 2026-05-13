/**
 * windows-coverage-noise-floor — refuse-and-print warning check.
 *
 * Detects coverage-gate deltas that are within the Windows / Node-22
 * noise floor — i.e., tiny fractional branch-coverage swings that vary
 * run-to-run and would chase the gate to a different file if the
 * operator ratcheted from a flapping CI artifact. The canonical mistake
 * is to fetch a failing run's coverage delta and bump the baseline by
 * that delta, which simply moves the noise floor to another file rather
 * than stabilising the gate.
 *
 * Scope: 'story-close', 'retro'. The check is `warning` severity (not
 * `blocker`) because flapping is informational — the operator decides
 * whether to ratchet, skip, or investigate. Coverage-blocking belongs
 * to a separate baseline-refresh gate.
 *
 * The check is `refuse-and-print`. A `fix()` here would mean either
 * suppressing the flap (which silently lowers signal) or ratcheting
 * (which is the very mistake the check exists to prevent). The
 * fixCommand advises against ratcheting from a flapping artifact.
 *
 * Input shape — the check reads `state.coverage`:
 *   {
 *     branchDelta: number,         // signed fractional delta (e.g. 0.0015 = +0.15%)
 *     noiseFloor?: number,         // optional override; default 0.0025
 *     file?: string,               // optional file the delta is attributed to
 *   }
 *
 * Returns null when `state.coverage` is absent (the assembler does not
 * always populate coverage; absent input is a no-op rather than a
 * failure).
 */

const DEFAULT_NOISE_FLOOR = 0.0025; // 0.25%

const FIX_COMMAND = [
  '# Do NOT ratchet the coverage baseline from a flapping CI artifact.',
  '# A delta within the Windows / Node-22 noise floor (< 0.25% by default)',
  '# is run-to-run jitter, not real coverage loss. Ratcheting in response',
  '# moves the noise floor to a different file rather than fixing it.',
  '#',
  '# Instead: re-run the gate. If the delta persists across multiple runs',
  '# in the same file, investigate the specific test that flipped — most',
  '# often a Date.now() / Math.random() leak into the branch decision.',
  '#',
  '# If the delta is real but small, capture a fresh baseline-refresh',
  '# commit deliberately, separate from the failing PR.',
].join('\n');

export default {
  id: 'windows-coverage-noise-floor',
  severity: 'warning',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',

  detect(state) {
    const cov = state?.coverage;
    if (!cov || typeof cov !== 'object') return null;
    if (typeof cov.branchDelta !== 'number' || Number.isNaN(cov.branchDelta)) {
      return null;
    }
    const noiseFloor =
      typeof cov.noiseFloor === 'number' && cov.noiseFloor > 0
        ? cov.noiseFloor
        : DEFAULT_NOISE_FLOOR;
    const absDelta = Math.abs(cov.branchDelta);
    // Within (or equal to) the floor → flapping → warning.
    // Above the floor → real signal → return null and let the actual
    // coverage gate decide.
    if (absDelta > noiseFloor) {
      return null;
    }
    const deltaPct = (cov.branchDelta * 100).toFixed(3);
    const floorPct = (noiseFloor * 100).toFixed(3);
    const fileNote = cov.file ? ` (file: ${cov.file})` : '';
    return {
      id: 'windows-coverage-noise-floor',
      severity: 'warning',
      scope: state?.scope ?? 'story-close',
      summary: `Branch-coverage delta ${deltaPct}% is within the Windows noise floor (${floorPct}%) — likely flap, do not ratchet${fileNote}`,
      detail: [
        `branchDelta: ${cov.branchDelta}`,
        `noiseFloor: ${noiseFloor}`,
        cov.file ? `attributedFile: ${cov.file}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
