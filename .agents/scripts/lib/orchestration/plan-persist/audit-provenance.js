/**
 * What an audit-seeded plan leaves for the next sweep: the provenance footers
 * each Story carries (the cross-run dedup memory) and the `audit::*` labels
 * (the dedup corpus is label-listed, so footers alone are invisible to an
 * indexed sweep). An N>1 plan whose seed carries `audit-finding` records
 * attributes each finding to the Stories covering its files; otherwise every
 * Story carries the seed union.
 */

import { auditLabelsPerStory } from './audit-attribution.js';

/**
 * @param {object|null} envelope
 * @returns {boolean}
 */
function seedWasTruncated(envelope) {
  return (envelope?.truncated ?? []).some((t) => t?.field === 'seed');
}

/**
 * The seed's provenance footers, in full. plan-context carries them apart
 * from the seed text (`seed.provenance`) so a size cut cannot drop one; an
 * envelope whose seed was cut and carries no such field cannot prove it
 * kept them, so persist refuses before creating anything — a dropped footer
 * is a finding silently re-filed by the next sweep.
 *
 * @param {object|null} envelope — the plan-context envelope, or null.
 * @returns {string}
 * @throws {Error} when the seed was truncated and its footers were not carried.
 */
export function resolveSeedProvenance(envelope) {
  const seed = envelope?.seed;
  if (typeof seed?.provenance === 'string') return seed.provenance;
  if (typeof seed?.content === 'string' && seedWasTruncated(envelope)) {
    throw new Error(
      '[plan-persist] the plan-context envelope truncated the seed and carries ' +
        'no seed.provenance, so audit provenance footers past the cut would be ' +
        'silently dropped and the next audit sweep would re-file those findings. ' +
        'Re-run plan-context with this Mandrel version to regenerate the ' +
        'envelope. No Issue was created.',
    );
  }
  return seed?.content ?? '';
}

/**
 * Stamp the `audit::*` labels. Union path (N==1, or a seed with no records):
 * every Story gets the seed's union labels. Attribution path: each Story gets
 * the labels of the findings stamped on its body.
 *
 * @param {Array<object>} stories
 * @param {string} [provenanceSource]
 * @returns {Array<object>}
 */
export function withAuditLabels(stories, provenanceSource) {
  const perStory = auditLabelsPerStory(stories, provenanceSource ?? '');
  return stories.map((story, i) => ({
    ...story,
    labels: [...new Set([...story.labels, ...perStory[i]])],
  }));
}
