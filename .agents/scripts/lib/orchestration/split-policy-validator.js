/**
 * v2 split-policy validator — the plan-time "one-owner-AC" split rejector.
 *
 * Under the v2 default-single split policy (`docs/roadmap.md` § v2.0.0), a
 * plan authors **one Story by default**; it splits into N>1 Stories only when
 * the pieces have near-zero overlap or sit across an architectural seam. This
 * validator is the deterministic guardrail on that policy: **every acceptance
 * criterion must belong to exactly one Story.** An identical AC appearing in
 * two Stories is evidence the split coupled what should have stayed one Story,
 * so the plan is refused rather than reconciled at delivery time (there is no
 * epic-level acceptance reconcile in v2).
 *
 * Scope of the deterministic check:
 *   - **Cross-Story duplication** (always): the same normalized AC text must
 *     not appear in more than one Story.
 *   - **Full coverage** (optional, when a plan-level `acceptance` manifest is
 *     supplied): every manifest AC is claimed by exactly one Story, and no
 *     Story claims an AC absent from the manifest.
 *
 * Semantic overlap between differently-worded ACs is **not** caught here — it
 * is a gate-#2 review call. This validator only sees identical (normalized)
 * text, keeping it deterministic and false-positive-free.
 *
 * Normalization for comparison: trim, collapse internal whitespace, and
 * lower-case. Reporting always uses the first-seen original text.
 */

/**
 * Normalize an acceptance string for equality comparison. Trims, collapses
 * runs of whitespace to a single space, and lower-cases. Non-strings and
 * empty/whitespace-only strings normalize to `null` (ignored).
 *
 * @param {unknown} ac
 * @returns {string | null}
 */
export function normalizeAcceptance(ac) {
  if (typeof ac !== 'string') return null;
  const norm = ac.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm === '' ? null : norm;
}

/**
 * @typedef {object} StorySlice
 * @property {string} [id]        Story identifier for reporting (slug or #id).
 * @property {string} [slug]      Alternate identifier (used when `id` absent).
 * @property {string[]} acceptance Acceptance criteria this Story claims.
 */

/**
 * @typedef {object} SplitPolicyViolation
 * @property {'cross-story-duplicate'|'orphan-ac'|'unclaimed-manifest-ac'} kind
 * @property {string} acceptance The original (first-seen) AC text.
 * @property {string[]} [stories] Story ids sharing a duplicated AC (`cross-story-duplicate`).
 * @property {string}   [story]   Story id owning an AC absent from the manifest (`orphan-ac`).
 */

/**
 * Resolve a Story's reporting id.
 *
 * @param {StorySlice} story
 * @param {number} index
 * @returns {string}
 */
function storyId(story, index) {
  if (story && typeof story.id === 'string' && story.id.trim() !== '') {
    return story.id;
  }
  if (story && typeof story.slug === 'string' && story.slug.trim() !== '') {
    return story.slug;
  }
  return `story[${index}]`;
}

/**
 * Validate that acceptance criteria partition cleanly across Stories.
 *
 * @param {StorySlice[]} stories The plan's Stories, each with `acceptance[]`.
 * @param {object} [opts]
 * @param {string[]} [opts.planAcceptance] Optional plan-level acceptance
 *   manifest. When supplied, coverage is enforced (every manifest AC claimed
 *   exactly once; no Story claims an off-manifest AC).
 * @returns {{ ok: boolean, violations: SplitPolicyViolation[] }}
 */
export function validateAcceptancePartition(stories, opts = {}) {
  const violations = [];
  const list = Array.isArray(stories) ? stories : [];

  // normalized AC → { original, owners: Set<storyId> }
  const owners = new Map();
  list.forEach((story, index) => {
    const id = storyId(story, index);
    const acceptance = Array.isArray(story?.acceptance) ? story.acceptance : [];
    for (const ac of acceptance) {
      const norm = normalizeAcceptance(ac);
      if (norm === null) continue;
      const existing = owners.get(norm);
      if (existing) {
        existing.owners.add(id);
      } else {
        owners.set(norm, { original: ac.trim(), owners: new Set([id]) });
      }
    }
  });

  // Cross-Story duplication: any AC owned by more than one Story.
  for (const { original, owners: set } of owners.values()) {
    if (set.size > 1) {
      violations.push({
        kind: 'cross-story-duplicate',
        acceptance: original,
        stories: [...set],
      });
    }
  }

  // Optional coverage check against a plan-level manifest.
  const manifest = Array.isArray(opts.planAcceptance)
    ? opts.planAcceptance
    : null;
  if (manifest !== null) {
    const manifestNorms = new Map();
    for (const ac of manifest) {
      const norm = normalizeAcceptance(ac);
      if (norm !== null && !manifestNorms.has(norm)) {
        manifestNorms.set(norm, ac.trim());
      }
    }
    // Every manifest AC must be claimed by exactly one Story.
    for (const [norm, original] of manifestNorms) {
      if (!owners.has(norm)) {
        violations.push({
          kind: 'unclaimed-manifest-ac',
          acceptance: original,
        });
      }
    }
    // No Story may claim an AC absent from the manifest.
    for (const [norm, { original, owners: set }] of owners) {
      if (!manifestNorms.has(norm)) {
        violations.push({
          kind: 'orphan-ac',
          acceptance: original,
          story: [...set][0],
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Render a single violation as a human-readable line.
 *
 * @param {SplitPolicyViolation} v
 * @returns {string}
 */
function formatViolation(v) {
  switch (v.kind) {
    case 'cross-story-duplicate':
      return `acceptance criterion appears in ${v.stories.length} Stories (${v.stories.join(', ')}) — a coupled split; keep it one Story: "${v.acceptance}"`;
    case 'unclaimed-manifest-ac':
      return `plan acceptance criterion is claimed by no Story: "${v.acceptance}"`;
    case 'orphan-ac':
      return `Story ${v.story} claims an acceptance criterion absent from the plan manifest: "${v.acceptance}"`;
    default:
      return `unknown split-policy violation: "${v.acceptance}"`;
  }
}

/**
 * Throwing wrapper for the persist path: throws a single batched error when
 * the acceptance criteria do not partition cleanly, otherwise returns
 * `stories` unchanged. Wired into `plan-persist` in Stage 3.
 *
 * @param {StorySlice[]} stories
 * @param {object} [opts] See {@link validateAcceptancePartition}.
 * @returns {StorySlice[]}
 */
export function assertAcceptancePartition(stories, opts = {}) {
  const { ok, violations } = validateAcceptancePartition(stories, opts);
  if (ok) return stories;
  throw new Error(
    `[split-policy] ${violations.length} acceptance-partition violation(s) — the plan splits coupled work; refuse:\n${violations
      .map((v) => `  - ${formatViolation(v)}`)
      .join('\n')}`,
  );
}
