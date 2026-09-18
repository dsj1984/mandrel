/**
 * review-providers/degraded-gates.js — the "a gate did not run" channel,
 * travelling beside `Finding[]` so "never ran" cannot read as clean. It
 * reports rather than blocks: close already hard-gates `npm run lint`.
 */

/**
 * @typedef {object} GateDegradation
 * @property {string} tool
 * @property {string} gate
 * @property {string} surface  Sub-surface that could not run.
 * @property {string} reason
 */

/**
 * Keep only well-formed records, so a misbehaving provider cannot corrupt output.
 *
 * @param {unknown} input
 * @returns {GateDegradation[]}
 */
export function normalizeDegradations(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const d of input) {
    if (!d || typeof d !== 'object') continue;
    const surface = typeof d.surface === 'string' ? d.surface : null;
    const reason = typeof d.reason === 'string' ? d.reason : null;
    if (surface === null || reason === null) continue;
    out.push({
      tool: typeof d.tool === 'string' ? d.tool : 'unknown',
      gate: typeof d.gate === 'string' ? d.gate : 'unknown',
      surface,
      reason,
    });
  }
  return out;
}

/**
 * Feature-detected; a throw degrades to empty. MUST be called after
 * `runReview`, which is when a provider records its degradations.
 *
 * @param {{ getDegradations?: Function }} reviewProvider
 * @param {{ warn?: Function }} [logger]
 * @returns {Promise<GateDegradation[]>}
 */
export async function collectProviderDegradations(reviewProvider, logger) {
  if (typeof reviewProvider?.getDegradations !== 'function') return [];
  try {
    return normalizeDegradations(await reviewProvider.getDegradations());
  } catch (err) {
    logger?.warn?.(
      `[code-review] getDegradations threw; treating as none. ${
        err?.message ?? err
      }`,
    );
    return [];
  }
}

/**
 * Empty renders `none`, so the field is always present.
 *
 * @param {ReadonlyArray<GateDegradation>} degradations
 * @returns {string}
 */
export function summarizeDegradations(degradations) {
  const rows = normalizeDegradations(degradations);
  if (rows.length === 0) return 'none';
  return rows.map((d) => `${d.gate}/${d.surface} (${d.reason})`).join(', ');
}

/**
 * @param {unknown} degradations
 * @returns {{ degraded: boolean, degradations: GateDegradation[] }}
 */
export function degradationEnvelope(degradations) {
  const rows = normalizeDegradations(degradations);
  return { degraded: rows.length > 0, degradations: rows };
}

/**
 * A throwing entry is logged and skipped; reporting must never fail a review.
 *
 * @param {ReadonlyArray<{ name: string, provider: { getDegradations?: Function } }>} entries
 * @param {{ warn?: Function }} [logger]
 * @returns {Promise<GateDegradation[]>}
 */
export async function mergeChainDegradations(entries, logger) {
  const merged = [];
  for (const entry of entries) {
    if (typeof entry.provider?.getDegradations !== 'function') continue;
    try {
      merged.push(
        ...normalizeDegradations(await entry.provider.getDegradations()),
      );
    } catch (err) {
      logger?.warn?.(
        `[code-review] Inline provider "${entry.name}" getDegradations threw; skipping. ${
          err?.message ?? err
        }`,
      );
    }
  }
  return merged;
}

/**
 * @param {ReadonlyArray<GateDegradation>} degraded  Already normalized.
 * @returns {string[]}
 */
export function renderDegradedHeaderLines(degraded) {
  if (degraded.length === 0) return [];
  return [`**Degraded gates**: ${degraded.length} (did not run)`];
}

/**
 * With a degraded gate, an all-zero tally must not read as a clean verdict.
 *
 * @param {ReadonlyArray<GateDegradation>} degraded  Already normalized.
 * @returns {string[]}
 */
export function renderNoFindingsBlock(degraded) {
  if (degraded.length === 0) {
    return [
      '### ✅ No findings',
      '',
      'No issues surfaced by the review provider.',
    ];
  }
  return [
    `### ⚠️ No findings — ${degraded.length} gate(s) did not run`,
    '',
    'The gates that ran surfaced no issues. This review does **not** vouch ' +
      'for the degraded surface(s) listed above.',
  ];
}

/**
 * @param {ReadonlyArray<GateDegradation>} degradations
 * @returns {string[]} markdown lines
 */
export function renderDegradedGatesSection(degradations) {
  const rows = normalizeDegradations(degradations);
  if (rows.length === 0) return [];
  const lines = [
    `### ⚠️ Degraded Gates (${rows.length})`,
    '',
    'The following review gate(s) **did not run**. Their surface is',
    'unreviewed — an all-zero finding tally below does not vouch for it.',
    '',
  ];
  for (const d of rows) {
    lines.push(
      `- \`${d.gate}\` → \`${d.surface}\` could not execute — ${d.reason} (emitter: \`${d.tool}\`).`,
    );
  }
  lines.push('');
  lines.push(
    'Verify with the canonical `npm run lint` before trusting this review.',
  );
  lines.push('');
  return lines;
}
