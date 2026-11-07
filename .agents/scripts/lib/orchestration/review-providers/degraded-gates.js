/**
 * review-providers/degraded-gates.js — the "a gate did not run" channel,
 * travelling beside `Finding[]` so "never ran" cannot read as clean. Its
 * `kind` blocks only under `delivery.codeReview.onNoVerdict: "block"`.
 */

/**
 * @typedef {'verdict-missing'|'coverage-partial'|'context-reduced'} DegradationKind
 * @typedef {object} GateDegradation
 * @property {string} tool
 * @property {string} gate
 * @property {string} surface  Sub-surface that could not run.
 * @property {DegradationKind} kind
 * @property {string} reason
 */

export const DEGRADATION_KINDS = Object.freeze([
  'verdict-missing',
  'coverage-partial',
  'context-reduced',
]);

/** An absent or unknown kind is the one kind that can never block. */
const kindOf = (kind) =>
  DEGRADATION_KINDS.includes(kind) ? kind : 'context-reduced';

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
      kind: kindOf(d.kind),
      reason,
    });
  }
  return out;
}

/**
 * Close's `gates.codeReview`: overridden > unreviewed > partial > degraded > passed.
 *
 * @param {unknown} degradations
 * @param {{ overridden?: boolean }} [opts]
 * @returns {'overridden'|'unreviewed'|'partial'|'degraded'|'passed'}
 */
export function reviewGateValue(degradations, { overridden = false } = {}) {
  if (overridden) return 'overridden';
  const kinds = new Set(normalizeDegradations(degradations).map((d) => d.kind));
  if (kinds.has('verdict-missing')) return 'unreviewed';
  if (kinds.has('coverage-partial')) return 'partial';
  return kinds.size > 0 ? 'degraded' : 'passed';
}

const REDUCED_CONTEXT =
  '⚠️ Review ran DEGRADED — reviewed with reduced context, so the surface(s) ' +
  'above were not fully checked. The close is not blocked by reduced ' +
  'context, but nothing here vouches for those surfaces.';

const NOT_VOUCHED =
  'unless `delivery.codeReview.onNoVerdict` is `block`; nothing here vouches ' +
  'for those surfaces.';

/**
 * @param {unknown} degradations
 * @returns {string[]}
 */
export function reviewGapLines(degradations) {
  const gate = reviewGateValue(degradations);
  if (gate === 'unreviewed') {
    return [
      `⚠️ Review UNREVIEWED — no verdict for the surface(s) above. The close is not blocked ${NOT_VOUCHED}`,
    ];
  }
  if (gate === 'partial') {
    return [
      `⚠️ Review ran PARTIAL — part of the diff above was not reviewed. The close is not blocked ${NOT_VOUCHED}`,
    ];
  }
  return gate === 'degraded' ? [REDUCED_CONTEXT] : [];
}

/** The fix each no-verdict cause needs; matched on the record, never on PII. */
const NO_VERDICT_FIXES = [
  [/not logged in|auth status/, 'run `claude auth login`'],
  [/out of quota|usage limit/, 'wait for the usage-limit reset'],
  [/skipped/, 'install the `claude` or `codex` CLI'],
  [/remote-base-ref-unresolved/, 'fetch the base ref'],
];

function fixFor(reason) {
  const hit = NO_VERDICT_FIXES.find(([re]) => re.test(reason));
  return hit ? hit[1] : 'fix the cause';
}

/**
 * Under `onNoVerdict: "block"`, a verdict-missing or coverage-partial record
 * halts the review; context-reduced never does.
 *
 * @param {{ degradations: unknown, onNoVerdict?: string, storyId: number|string }} args
 * @returns {{ halted: true, haltCause: 'no-verdict', blockerReason: string }|null}
 */
export function resolveNoVerdictHalt({ degradations, onNoVerdict, storyId }) {
  if (onNoVerdict !== 'block') return null;
  const blocking = normalizeDegradations(degradations).filter(
    (d) => d.kind !== 'context-reduced',
  );
  if (blocking.length === 0) return null;
  const causes = blocking.map(
    (d) => `${d.surface} [${d.kind}]: ${d.reason} — ${fixFor(d.reason)}`,
  );
  return {
    halted: true,
    haltCause: 'no-verdict',
    blockerReason:
      `code-review produced no verdict for part or all of the diff ` +
      `(delivery.codeReview.onNoVerdict: block): ${causes.join('; ')}. ` +
      `Then re-run \`node .agents/scripts/story-review-compute.js --story ${storyId}\`.`,
  };
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
      `- \`${d.gate}\` → \`${d.surface}\` (${d.kind}) could not execute — ${d.reason} (emitter: \`${d.tool}\`).`,
    );
  }
  lines.push('');
  lines.push(
    'Verify with the canonical `npm run lint` before trusting this review.',
  );
  lines.push('');
  return lines;
}
