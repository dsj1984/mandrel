/**
 * Cross-Story conflict-finding gate for `epic-deliver-prepare.js`.
 *
 * Story #2297 — when the bounded `/plan` flow emitted concurrency
 * findings (Story #2296's validator pass), the operator may have shipped
 * them through to `/deliver` without resolving the underlying
 * `depends_on` gaps. This gate runs at Phase 1 of `/deliver` and
 * refuses to flip the Epic to `agent::executing` when the upcoming
 * waves still contain unresolved conflicts — surfacing the exact
 * remediation commands the operator should run before retrying.
 *
 * The gate is opt-in by default:
 *   - Advisory findings (severity 'soft') only log a summary.
 *   - Hard findings (severity 'hard') OR `delivery.failOnConcurrencyHazards: true`
 *     promote a hard-stop.
 *
 * `--ignore-concurrency-hazards` bypasses the gate; the flag use is
 * recorded on the Epic checkpoint so retro tooling can flag a run that
 * shipped despite an outstanding hazard.
 *
 * The module is pure: it consumes a findings array and a wave plan and
 * returns either a `{ ok: true }` envelope or throws. No I/O.
 */

/**
 * Build the set of "pending" story identifiers from a wave plan. A Story
 * is pending unless its labels carry `agent::done`. Identifiers are
 * collected in three shapes — `id` (number), `number`, and `slug` — so
 * the caller can match findings keyed by any of them.
 *
 * @param {Array<Array<{ id?: number|string, number?: number|string, slug?: string, labels?: string[] }>>} wavePlan
 * @returns {Set<string>}
 */
export function collectPendingStoryKeys(wavePlan) {
  const pending = new Set();
  if (!Array.isArray(wavePlan)) return pending;
  for (const wave of wavePlan) {
    if (!Array.isArray(wave)) continue;
    for (const story of wave) {
      if (!story || typeof story !== 'object') continue;
      const labels = Array.isArray(story.labels) ? story.labels : [];
      if (labels.includes('agent::done')) continue;
      if (story.id != null) pending.add(String(story.id));
      if (story.number != null) pending.add(String(story.number));
      if (story.slug != null) pending.add(String(story.slug));
    }
  }
  return pending;
}

/**
 * Extract every story identifier a finding references. Both finding
 * kinds in #2296's shape carry slugs; future persisted shapes may carry
 * numeric IDs — accept both transparently.
 */
function findingStoryKeys(finding) {
  const keys = [];
  if (Array.isArray(finding?.storySlugs)) {
    for (const s of finding.storySlugs) keys.push(String(s));
  }
  if (finding?.producer?.storySlug != null) {
    keys.push(String(finding.producer.storySlug));
  }
  if (finding?.consumer?.storySlug != null) {
    keys.push(String(finding.consumer.storySlug));
  }
  return keys;
}

/**
 * Filter findings to those that touch at least one pending Story. A
 * finding all of whose referenced Stories are already `agent::done` is
 * harmless — the conflict has already played out — and is dropped.
 *
 * When `pendingKeys` is empty (every wave is done) every finding is
 * filtered out. When a finding carries no identifiers (shape drift),
 * conservatively keep it so the operator sees the signal.
 *
 * @param {object[]} findings
 * @param {Set<string>} pendingKeys
 * @returns {object[]}
 */
export function filterFindingsToPending(findings, pendingKeys) {
  if (!Array.isArray(findings)) return [];
  if (!(pendingKeys instanceof Set)) return findings;
  return findings.filter((f) => {
    const keys = findingStoryKeys(f);
    if (keys.length === 0) return true;
    return keys.some((k) => pendingKeys.has(k));
  });
}

function isHardFinding(f) {
  return f && f.severity === 'hard';
}

/**
 * Render the operator-facing remediation block for a hard-gate trip.
 * Produces a single multi-line string suitable for `throw new Error(...)`
 * — names every offending path, the affected Stories, and the exact
 * `gh issue edit` commands needed to add the missing `depends_on` links.
 */
export function renderGateErrorMessage(findings, ownerRepo) {
  const lines = [
    'Refusing to flip Epic to agent::executing — cross-Story concurrency hazards remain unresolved.',
    '',
  ];
  const sharedEditors = findings.filter((f) => f.kind === 'shared-editor');
  const implicit = findings.filter(
    (f) => f.kind === 'implicit-cross-story-dep',
  );
  if (sharedEditors.length > 0) {
    lines.push('Shared-editor conflicts:');
    for (const f of sharedEditors) {
      const stories = Array.isArray(f.storySlugs) ? f.storySlugs : [];
      lines.push(
        `  - "${f.path}" written by ${stories.length} concurrent Stories: ${stories.map((s) => `#${s}`).join(', ')}`,
      );
      lines.push(
        '    Remediation: add a `depends_on` chain or split the edits into a dedicated late-wave wiring Story.',
      );
    }
    lines.push('');
  }
  if (implicit.length > 0) {
    lines.push('Implicit cross-Story dependencies:');
    for (const f of implicit) {
      const p = f.producer ?? {};
      const c = f.consumer ?? {};
      lines.push(
        `  - "${f.path}" produced by Story #${p.storySlug ?? '?'} consumed by Story #${c.storySlug ?? '?'} (body.${c.sourceField ?? '?'})`,
      );
      const repoFlag = ownerRepo ? ` --repo ${ownerRepo}` : '';
      lines.push(
        `    Remediation: gh issue edit ${c.storySlug ?? '?'}${repoFlag} --add-body $'\\n\\nblocked by #${p.storySlug ?? '?'}'`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Resolve the listed conflicts and re-run `/deliver`, or pass `--ignore-concurrency-hazards` to bypass this gate.',
  );
  return lines.join('\n');
}

/**
 * Apply the gate to a findings array.
 *
 * @param {object}    input
 * @param {object[]}  input.findings        - Findings filtered to pending waves.
 * @param {object}    [input.policy]        - Resolved `delivery.failOnConcurrencyHazards` (boolean).
 * @param {boolean}   [input.ignore]        - `--ignore-concurrency-hazards` flag value.
 * @param {string}    [input.ownerRepo]     - "owner/repo" string for `gh issue edit` hints.
 * @returns {{ tripped: boolean, reason: 'hard-severity'|'config-fail-on'|null, findings: object[], bypassed: boolean }}
 *          When the gate trips and `ignore` is false the caller should
 *          throw `renderGateErrorMessage(findings, ownerRepo)`. The
 *          returned `bypassed` is true when `ignore` short-circuits a
 *          trip; record it on the checkpoint.
 */
export function evaluateConcurrencyGate({
  findings = [],
  policy = {},
  ignore = false,
  ownerRepo,
} = {}) {
  void ownerRepo;
  const hardFindings = findings.filter(isHardFinding);
  const failOnConcurrencyHazards = policy.failOnConcurrencyHazards === true;
  if (hardFindings.length > 0) {
    return {
      tripped: true,
      reason: 'hard-severity',
      findings: hardFindings,
      bypassed: ignore === true,
    };
  }
  if (failOnConcurrencyHazards && findings.length > 0) {
    return {
      tripped: true,
      reason: 'config-fail-on',
      findings,
      bypassed: ignore === true,
    };
  }
  return { tripped: false, reason: null, findings: [], bypassed: false };
}
