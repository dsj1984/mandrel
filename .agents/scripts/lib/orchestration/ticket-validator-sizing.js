/**
 * Story sizing model — a small flat set of knobs plus the optional `wide`
 * declaration that lifts the hard file-width rejection. Co-located with
 * `ticket-validator.js`, but kept as its own module so the validator's
 * primary file stays under the maintainability ceiling. The validator
 * imports `computeSizingFindings` and `renderHardFindingError` and stitches
 * the result onto its return value as `findings` / `errors`.
 *
 * `DEFAULT_TASK_SIZING` is the **single source of truth** for the sizing
 * thresholds. The decomposer prompt template
 * (`.agents/scripts/lib/templates/decomposer-prompts.js`) and the authoring
 * SKILL (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`) reference
 * these numbers rather than restating divergent ones — the prompt generates
 * its threshold sentence from this constant so the two surfaces cannot drift.
 * Keep it in lockstep with `.agents/schemas/agentrc.schema.json`
 * (`$defs.taskSizing`) and the JS mirror in
 * `.agents/scripts/lib/config-settings-schema.js`.
 *
 * Sizing model (Story #3760 — profile-matrix collapse; Story #3874 — one
 * uniform relaxed profile; the hard acceptance ceiling was removed after the
 * Epic #4355 decomposition experiment showed it forced fragmentation):
 *   - Flat knobs: `softFiles` (~15), `hardFiles` (~30),
 *     `softAcceptanceCount` (~10). No per-profile ceiling map, no parallel
 *     `testSurface` axis, no selector and no second profile. Acceptance
 *     mass is advisory-only.
 *   - The four-profile `sizingProfile` enum is replaced by a single optional
 *     `wide` declaration carrying a one-line human-readable reason. Declaring
 *     `wide` with a reason lifts the `hardFiles` rejection; no Story is
 *     rejected for width when `wide` is declared.
 *   - Cohesion is the primary heuristic (one Story = one coherent change with
 *     one reason to exist); the numeric ceilings are a backstop. See the
 *     decomposer prompt and authoring SKILL.
 */

import { parse as parseStoryBody } from '../story-body/story-body.js';

/**
 * Normalize a Story's `body` to the structured object the sizing layers
 * score, mirroring `validateAcFreshness` / `collectStoryAssumptionEntries`
 * (Story #3302) and `resolveStructuredBody` in `task-body-validator.js`.
 *
 * The decomposer emits `body` as the canonical serialized **string**
 * (`decomposer-prompts.js`), but the sizing layers historically read
 * `story.body` only when it was already an object — so on the production
 * string shape `changes` / `wide` fell through to empty and the `hardFiles`
 * / unanchored-constant backstops emitted nothing. A defensive parse here
 * restores parity:
 *   - **string body** → parsed via `parseStoryBody`; an unparseable string
 *     yields `null` (the gate degrades to "no structured signal", never
 *     throws mid-validation).
 *   - **object body** → returned verbatim (a caller may pass the
 *     pre-serialize shape directly; `parse` round-trips it).
 *   - **null / other** → `null`.
 *
 * @param {object} story
 * @returns {object|null}
 */
function resolveStoryBody(story) {
  const body = story?.body;
  if (typeof body === 'string') {
    if (body.trim().length === 0) return null;
    try {
      return parseStoryBody(body).body;
    } catch {
      return null;
    }
  }
  if (body !== null && typeof body === 'object') return body;
  return null;
}

/**
 * Resolve the acceptance-criteria array for a Story, preferring the
 * authoritative top-level `story.acceptance` (the binding contract the
 * validator already requires every Story to carry inline) over the
 * structured body's `acceptance`. Reading the top-level array makes the
 * acceptance ceiling correct regardless of body shape — a string body whose
 * structured `acceptance` is only reachable after a parse, or an object body
 * (Story #4271). Falls back to `resolveStoryBody(story).acceptance` only when
 * the top-level array is absent.
 *
 * @param {object} story
 * @returns {unknown[]}
 */
function resolveAcceptance(story) {
  if (Array.isArray(story?.acceptance)) return story.acceptance;
  const body = resolveStoryBody(story);
  return Array.isArray(body?.acceptance) ? body.acceptance : [];
}

/**
 * Resolve the `depends_on` edge list for a Story. `depends_on` may live at the
 * top level (the validator normalizes it there — see `ticket-validator.js`) or
 * inside the structured body (the shape `story-body.js` parses out). Prefer the
 * top-level array, falling back to the resolved body's `depends_on`. Returns
 * only non-empty string slugs — mirroring the `story-body.js` normalization so
 * a blank / non-string edge never counts as a real dependency.
 *
 * The cross-Story validator already rejects any `depends_on` slug that does not
 * match a sibling in the same decomposition, so every edge that survives to the
 * sizing layer is guaranteed to point at a sibling. The merge-candidate
 * heuristic therefore only needs to know whether the list is non-empty.
 *
 * @param {object} story
 * @returns {string[]}
 */
function resolveDependsOn(story) {
  const raw = Array.isArray(story?.depends_on)
    ? story.depends_on
    : (resolveStoryBody(story)?.depends_on ?? []);
  return Array.isArray(raw)
    ? raw.filter((d) => typeof d === 'string' && d.trim().length > 0)
    : [];
}

export const DEFAULT_TASK_SIZING = Object.freeze({
  // Typical-Story warning thresholds (soft — emit advisory findings).
  // Story #4162 raised `softFiles` 8 → 15: a capability-sized Story routinely
  // touches a dozen-plus files for one cohesive reason, so the advisory width
  // nudge fired far too eagerly and biased the decomposer toward over-slicing.
  // The hard `hardFiles` rejection (30) is unchanged.
  softFiles: 15,
  softAcceptanceCount: 10,
  // Hard ceiling (rejection unless lifted via `wide`). Acceptance mass has
  // no hard ceiling: the former `maxAcceptance` rejection forced careful,
  // fine-grained specs to fragment one coherent capability into dependent
  // slices (observed on Epic #4355), so it was removed — the delivery-
  // schedule simulation in the decomposer prompt owns that judgment now.
  hardFiles: 30,
  // Under-size (merge-candidate) thresholds (Story #4312). A Story with a
  // footprint at or below BOTH ceilings that also carries at least one
  // `depends_on` edge to a sibling looks like a dependent fragment rather than
  // a capability slice — the machine-checkable form of the single-consumer
  // merge rule. Emitted as a `soft` advisory only; never a rejection. A tiny
  // ORPHAN Story (no `depends_on`) stays silent — small orthogonal slices are
  // legitimate.
  mergeCandidateMaxFiles: 3,
  mergeCandidateMaxAcceptance: 4,
});

/**
 * `DELIVERABLE_GRANULARITY_GUIDANCE` is the **single source of truth** for the
 * deliverable-granularity definition of a Story (Story #3777). It is stated
 * ONCE here and consumed by BOTH the decomposer prompt template
 * (`.agents/scripts/lib/templates/decomposer-prompts.js`, which interpolates
 * the string verbatim) AND the authoring SKILL
 * (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`, whose prose
 * mirrors these sentences). The SKILL cannot import JS, so the
 * `epic-plan-decompose-author` smoke test and the `ticket-decomposer` prompt
 * test both assert the canonical phrasing on each surface — a divergent
 * restatement fails those gates. This reuses the #3760 single-source
 * mechanism (one constant, two surfaces, drift-gated by tests).
 *
 * The definition: a Story is a **capability slice a frontier model delivers
 * and self-verifies in one pass** — a shippable slice a reviewer would accept
 * as a single PR — not a single module or file. Module-level slices fold into
 * the capability they belong to, and a Story whose only consumer is one
 * sibling Story is merged into that sibling (single-consumer merge rule).
 *
 * The `envelopeFloor` sentence is the **soft** complement to the sizing
 * section's envelope framing (Story #4313): the delivery envelope
 * (`maxTokenBudget`) bounds the TOP of a Story, but under-utilizing it is
 * itself a merge signal. It is deliberately prose-only — an illustrative
 * fraction, not a threshold constant, and no validator finding backs it (the
 * mechanical backstop is the `merge-candidate` finding). It names the
 * per-Story delivery-session cost (hydration, branch, PR, review, CI) so the
 * "models one-shot bigger things now" planning assumption is stated, not
 * implicit.
 */
export const DELIVERABLE_GRANULARITY_GUIDANCE = Object.freeze({
  // The one-sentence definition of Story granularity.
  definition:
    'A Story is a **capability slice a frontier model delivers and self-verifies in one pass** — a shippable slice a reviewer would accept as a single PR, a capability or user-visible surface, **not a single module or file**. Fold module-level slices into the capability they belong to rather than emitting one Story per module.',
  // The single-consumer merge rule.
  singleConsumerRule:
    '**Single-consumer merge rule.** A Story whose only consumer is one sibling Story should be **merged into that sibling** rather than emitted separately — a single-consumer downstream slice is not its own unit of work.',
  // The envelope-floor heuristic (soft; no validator finding — Story #4313).
  envelopeFloor:
    '**Envelope floor — under-utilizing the envelope is a merge signal.** A Story that would plausibly consume well under a third of the delivery envelope (`maxTokenBudget`) and is neither parallel-deliverable nor orthogonal to its siblings should be **merged into its consumer**. The fraction is illustrative, not a threshold — the point is that modern frontier models one-shot capability-sized changes, so a chain of small dependent Stories needlessly pays a full delivery session (hydration, branch, PR, review, CI) per link. Merge such links up unless a parallelism or orthogonality reason justifies the separate slice.',
});

/**
 * `AUTHORING_ALTITUDE_GUIDANCE` is the **single source of truth** for the
 * binding-vs-advisory authoring altitude (Epic #4131 F8) and the New-File
 * Contract (Story #4272). It is stated ONCE here and consumed by BOTH the
 * decomposer prompt template
 * (`.agents/scripts/lib/templates/decomposer-prompts.js`, which interpolates
 * the strings verbatim into the rendered system prompt) AND the authoring
 * SKILL (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`, whose
 * prose mirrors these sentences). The SKILL cannot import JS, so the
 * `ticket-decomposer` prompt test asserts the canonical phrasing on both
 * surfaces — a divergent restatement fails that gate. This reuses the #3777
 * single-source mechanism (one constant, two surfaces, drift-gated by tests).
 *
 * The altitude: `acceptance[]` / `verify[]` are the **binding contract** (the
 * sole definition of "done"); `changes[]` / `references[]` are an **advisory
 * implementation sketch** the executor MAY revise. Author acceptance to assert
 * the **outcome** independent of file layout — never pin an incidental helper
 * name or private path into an acceptance item. The advisory sketch is still
 * validated (base-branch probes, New-File Contract) and never licenses
 * skipping `acceptance[]` / `verify[]` or any `rules/security-baseline.md` MUST.
 */
export const AUTHORING_ALTITUDE_GUIDANCE = Object.freeze({
  // The binding-vs-advisory altitude statement.
  altitude:
    '**Binding contract vs advisory sketch.** `acceptance[]` and `verify[]` are the Story\'s **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: your best prediction of the file footprint, which the executor MAY revise when the real codebase diverges from the sketch. Author `acceptance[]` / `verify[]` to assert the **outcome** independent of any one file layout — never pin an incidental implementation detail (an internal helper name, a private file path) into an acceptance item that the advisory `changes[]` is free to reshape; assert the observable behaviour instead.',
  // The advisory-does-not-mean-unvalidated caveat.
  advisoryCaveat:
    "**Advisory does not mean unvalidated.** `changes[]` paths still pass the base-branch file-assumption probes (a `creates` against an existing path still fails), the New-File Contract still holds, and the executor's latitude to revise the approach never licenses skipping `acceptance[]` / `verify[]` or relaxing any `rules/security-baseline.md` MUST.",
  // The New-File Contract.
  newFileContract:
    '**New-File Contract.** Any path named in a Story\'s `goal`, `acceptance`, or `verify` that does NOT already exist on `main` MUST also appear in that Story\'s `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose — even when the Story is the one authoring the file.',
});

/**
 * Configuration-constant phrase patterns the `unanchored-constant` heuristic
 * scans Story acceptance criteria for. Each entry matches the *kind* of
 * tunable an implementing agent would otherwise have to context-hop to the
 * Tech Spec (or an ADR) to resolve: a retention window, a rate limit, a
 * timeout, an age cutoff, a bounded window, a per-unit cap, or a quota.
 *
 * The list is the single source of truth for the heuristic and intentionally
 * narrow — it targets the small set of config constants that recur across
 * Stories and that an author can almost always inline as a concrete value at
 * authoring time. Anchored with `\b` word boundaries so substrings inside
 * unrelated prose ("maximum", "timeouts handled elsewhere") don't over-match.
 *
 * Covered phrases (acceptance criterion of Story #3855):
 *   - `retention window`
 *   - `rate limit` / `rate-limit`
 *   - `timeout`
 *   - `older than`
 *   - `within N` (a bounded count/duration window)
 *   - `max ... per ...` (a per-unit cap, e.g. "max requests per second")
 *   - `quota`
 */
const UNANCHORED_CONSTANT_PATTERNS = Object.freeze([
  /\bretention window\b/i,
  /\brate[ -]limit\b/i,
  /\btimeout\b/i,
  /\bolder than\b/i,
  /\bwithin\b/i,
  /\bmax\b[^.]*\bper\b/i,
  /\bquota\b/i,
]);

/**
 * Matches a concrete numeric value anywhere in an acceptance criterion. A
 * bare digit run is enough to count as "anchored": `"older than 90 days"`,
 * `"5 req/s"`, `"within 30 minutes"`, and `"max 100 per hour"` all carry a
 * digit, so they are not flagged. Spelled-out small numbers are intentionally
 * NOT treated as anchors — the heuristic nudges authors toward an explicit
 * numeral the implementing agent can copy verbatim.
 */
const CONCRETE_VALUE_RE = /\d/;

/**
 * Soft, advisory `unanchored-constant` finding (Story #3855). Surfaces a
 * Story acceptance criterion that references a configuration constant
 * (retention window, rate limit, timeout, threshold) without stating a
 * concrete numeric value inline — so an implementing agent doesn't have to
 * context-hop to the Tech Spec or guess. Advisory only: `normalizeTickets`
 * still returns successfully and the finding rides the advisory nudges array
 * alongside the sizing soft findings.
 */
function makeUnanchoredConstant(slug, criterion) {
  return {
    kind: 'unanchored-constant',
    severity: 'soft',
    ticketSlug: slug,
    criterion,
    message: `Acceptance criterion references a configuration constant without a concrete value: "${criterion}". Specify the value inline (e.g. "90 days", "5 req/s", "30 minutes") so the implementing agent doesn't have to read the Tech Spec or guess.`,
  };
}

/**
 * Scan a single Story's acceptance criteria for unanchored configuration
 * constants. A criterion trips the finding when it matches one of
 * `UNANCHORED_CONSTANT_PATTERNS` and carries NO concrete numeric value
 * (`CONCRETE_VALUE_RE`) — the digit is the signal the author already inlined
 * the value, so a criterion like `"older than 90 days"` is left alone while
 * `"older than the retention window"` is flagged. One finding per offending
 * criterion.
 */
function computeUnanchoredConstantFindings(story) {
  const out = [];
  // Read the authoritative top-level `story.acceptance` (the binding
  // contract), falling back to the structured body's acceptance only when the
  // top-level array is absent. This is correct regardless of body shape —
  // string or object (Story #4271).
  const acceptance = resolveAcceptance(story);
  for (const item of acceptance) {
    const criterion = String(item ?? '');
    if (CONCRETE_VALUE_RE.test(criterion)) continue;
    const matches = UNANCHORED_CONSTANT_PATTERNS.some((re) =>
      re.test(criterion),
    );
    if (matches) {
      out.push(makeUnanchoredConstant(story.slug, criterion));
    }
  }
  return out;
}

/**
 * Soft, advisory `missing-reason-to-exist` finding (Story #4273). Surfaces a
 * Story whose body carries no non-empty `reason_to_exist` — the
 * machine-checkable form of the cohesion rule (**one Story = one coherent
 * change with one reason to exist**). `reason_to_exist` is marked REQUIRED by
 * the decomposer prompt and is the field the `epic-plan-consolidate` critic
 * gates on, but that critic is an honor-system LLM check with no runtime
 * backstop. This deterministic finding is the cheap backstop.
 *
 * Severity is `soft` (not a hard reject) so existing `reason_to_exist`-less
 * standalone / audit Stories are surfaced as an advisory nudge rather than
 * blocked — matching the `unanchored-constant` finding's advisory contract.
 */
function makeMissingReasonToExist(slug) {
  return {
    kind: 'missing-reason-to-exist',
    severity: 'soft',
    ticketSlug: slug,
    message:
      'Story body carries no non-empty `reason_to_exist`. State the single coherent reason this Story exists in one sentence (the machine-checkable form of "one Story = one coherent change with one reason to exist"), encoded as the `reason_to_exist` field of the body meta comment.',
  };
}

/**
 * Emit a soft `missing-reason-to-exist` finding when the Story body resolves
 * to no non-empty `reason_to_exist`. The body parser
 * (`story-body/story-body.js`) already normalizes `reason_to_exist` to a
 * non-empty trimmed string or `null`, so reading `body.reason_to_exist` after
 * `resolveStoryBody` is correct regardless of body shape — a serialized
 * **string** body (the production decomposer shape) or an object body
 * (Story #4271). A body that fails to parse resolves to `null` and trips the
 * finding, which is the right advisory signal: the author should re-emit a
 * parseable body carrying the field. One finding per Story.
 */
function computeMissingReasonToExistFinding(story) {
  const body = resolveStoryBody(story);
  const reason = body?.reason_to_exist;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;
  return hasReason ? [] : [makeMissingReasonToExist(story.slug)];
}

/**
 * Soft, advisory `merge-candidate` finding (Story #4312). Surfaces a Story that
 * looks like a dependent fragment rather than a capability slice — the
 * machine-checkable form of the single-consumer merge rule
 * (`DELIVERABLE_GRANULARITY_GUIDANCE.singleConsumerRule`). Never a rejection:
 * `severity: 'soft'`, so it rides the advisory `findings[]` channel and never
 * enters the hard `errors[]` array.
 *
 * The rendered message names the depended-on sibling slug(s) and recommends
 * merging into the consumer, mirroring the tone of the `wide-undeclared` nudge.
 */
function makeMergeCandidate(slug, fileCount, acceptanceCount, dependsOn) {
  const siblings = dependsOn.map((d) => `"${d}"`).join(', ');
  return {
    kind: 'merge-candidate',
    severity: 'soft',
    ticketSlug: slug,
    fileCount,
    acceptanceCount,
    dependsOn,
    message: `Story "${slug}" is a thin dependent slice (${fileCount} declared file(s), ${acceptanceCount} acceptance item(s)) that depends on sibling(s) ${siblings}. A Story whose only role is to feed one sibling is not its own unit of work — consider merging it into the consumer (single-consumer merge rule) rather than shipping it as a separate slice.`,
  };
}

/**
 * Emit a soft `merge-candidate` finding when a Story meets the under-size
 * heuristic (Story #4312): footprint ≤ `mergeCandidateMaxFiles` declared
 * `changes[]` files AND ≤ `mergeCandidateMaxAcceptance` acceptance items AND at
 * least one `depends_on` edge to a sibling. All three conditions MUST hold — a
 * tiny ORPHAN Story (no `depends_on`) stays silent because small orthogonal
 * slices are legitimate. Glob entries mark the footprint as unknown-width, so a
 * glob-carrying Story is never a merge candidate.
 *
 * @param {object} story
 * @param {{ fileCount: number, hasGlobs: boolean }} changesAnalysis
 * @param {number} acceptanceCount
 * @param {object} sizing
 * @returns {object[]}
 */
function computeMergeCandidateFinding(
  story,
  changesAnalysis,
  acceptanceCount,
  sizing,
) {
  if (changesAnalysis.hasGlobs) return [];
  const dependsOn = resolveDependsOn(story);
  if (dependsOn.length === 0) return [];
  if (changesAnalysis.fileCount > sizing.mergeCandidateMaxFiles) return [];
  if (acceptanceCount > sizing.mergeCandidateMaxAcceptance) return [];
  return [
    makeMergeCandidate(
      story.slug,
      changesAnalysis.fileCount,
      acceptanceCount,
      dependsOn,
    ),
  ];
}

/**
 * Returns true when a `changes[]` entry is a glob pattern. Handles both the
 * canonical PathEntry object form `{ path, assumption }` and legacy strings.
 */
function isGlobBullet(bullet) {
  const s = bullet?.path ?? bullet;
  return typeof s === 'string' && s.includes('*');
}

/**
 * Extract the path-shaped head from a single `changes` entry. Handles the
 * canonical PathEntry object form (path used directly) and the legacy
 * `"<path>: <verb>"` string form (slices on the first colon).
 */
function extractChangeBulletPath(bullet) {
  const s = typeof bullet === 'string' ? bullet : (bullet?.path ?? null);
  if (!s) return null;
  const colonIdx = s.indexOf(':');
  if (colonIdx <= 0) return /[\\/.]/.test(s) ? s.trim() : null;
  const head = s.slice(0, colonIdx).trim();
  return /[\\/.]/.test(head) ? head : null;
}

/**
 * Analyse the `changes[]` array and return:
 *   - `fileCount` — number of unique non-glob path-shaped heads
 *   - `hasGlobs`  — true when at least one bullet is a glob pattern
 *
 * Handles both the canonical PathEntry object form `{ path, assumption }` and
 * the legacy string form via the underlying helpers.
 */
function analyseChanges(changes) {
  const paths = new Set();
  let hasGlobs = false;
  for (const bullet of changes) {
    if (isGlobBullet(bullet)) {
      hasGlobs = true;
      continue;
    }
    const path = extractChangeBulletPath(bullet);
    if (path) paths.add(path);
  }
  return { fileCount: paths.size, hasGlobs };
}

function makeOversized(slug, field, observed, ceiling) {
  return {
    kind: 'oversized-task',
    severity: 'hard',
    ticketSlug: slug,
    field,
    observed,
    ceiling,
  };
}

function makeSoftWidth(slug, field, observed, soft) {
  return {
    kind: 'soft-task-width',
    severity: 'soft',
    ticketSlug: slug,
    field,
    observed,
    soft,
  };
}

/**
 * Returns true when the Story declares itself `wide` with a non-empty reason.
 * A `wide` declaration lifts the `hardFiles` rejection: a legitimately broad
 * change states why it is broad rather than being silently capped. The
 * reason is the only payload — there is no longer a profile enum to match.
 */
function isDeclaredWide(wide) {
  return (
    wide !== null &&
    typeof wide === 'object' &&
    typeof wide.reason === 'string' &&
    wide.reason.trim().length > 0
  );
}

/**
 * Compute the hard + soft sizing findings for a single Story. Layers:
 *   - acceptance ceiling (`maxAcceptance`) + soft warn (`softAcceptanceCount`)
 *   - file-width ceiling (`hardFiles`) + soft warn (`softFiles`)
 *   - the optional `wide` declaration, which lifts the hard file ceiling
 *   - glob-awareness (glob entries are unknown-width; numeric ceiling skipped)
 *
 * Cohesion is the primary authoring heuristic (see the decomposer prompt and
 * SKILL); these numeric findings are the backstop. A wide Story declares
 * `wide` with a reason instead of being rejected for width.
 */
function computeStorySizingFindings(story, sizing) {
  const out = [];
  // Story #4271: normalize the body so the canonical serialized **string**
  // shape the decomposer emits is scored at parity with the pre-serialize
  // object shape. The acceptance ceiling reads the authoritative top-level
  // `story.acceptance` (the binding contract), not `body.acceptance`.
  const body = resolveStoryBody(story);
  const acceptance = resolveAcceptance(story);
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  const declaredWide = isDeclaredWide(body?.wide ?? null);
  const changesAnalysis = analyseChanges(changes);

  // Soft, advisory: flag acceptance criteria that reference a configuration
  // constant without inlining a concrete value (Story #3855). Independent of
  // the numeric sizing layers below — purely an authoring nudge.
  out.push(...computeUnanchoredConstantFindings(story));

  // Soft, advisory: flag a Story body that carries no non-empty
  // `reason_to_exist` (Story #4273). The decomposer prompt marks the field
  // REQUIRED and the consolidate critic gates on it, but that critic has no
  // runtime backstop — this deterministic finding is the cheap backstop.
  // Independent of the numeric sizing layers below.
  out.push(...computeMissingReasonToExistFinding(story));

  // Soft, advisory: flag a thin dependent slice (Story #4312) — the symmetric
  // under-size backstop to the over-size ceilings. A tiny footprint with a
  // `depends_on` edge to a sibling is a merge candidate under the
  // single-consumer merge rule. Independent of the numeric sizing layers below.
  out.push(
    ...computeMergeCandidateFinding(
      story,
      changesAnalysis,
      acceptance.length,
      sizing,
    ),
  );

  // Acceptance mass is advisory-only (Story #4312's under-size heuristic is
  // the merge signal; the former hard `maxAcceptance` rejection is removed).
  // A long binding contract is a re-check-cohesion nudge, never by itself a
  // decomposition error — cohesion and the delivery envelope govern Story
  // size, and the delivery-schedule simulation in the decomposer prompt owns
  // the fragmentation/consolidation judgment.
  if (acceptance.length > sizing.softAcceptanceCount) {
    out.push(
      makeSoftWidth(
        story.slug,
        'acceptance',
        acceptance.length,
        sizing.softAcceptanceCount,
      ),
    );
  }

  const { fileCount, hasGlobs } = changesAnalysis;

  // Glob entries mark the Story as unknown-width: a glob cannot be bounded by
  // the numeric ceiling, so skip it. A non-wide Story carrying globs gets an
  // informational nudge to either narrow the change or declare `wide`.
  if (hasGlobs) {
    if (!declaredWide) {
      out.push({
        kind: 'wide-undeclared',
        severity: 'soft',
        ticketSlug: story.slug,
        reason: 'glob-changes',
      });
    }
    return out;
  }

  // File-width: a single ceiling. `wide` (with a reason) lifts the hard cap.
  if (fileCount > sizing.hardFiles && !declaredWide) {
    out.push(
      makeOversized(story.slug, 'fileCount', fileCount, sizing.hardFiles),
    );
  } else if (fileCount > sizing.softFiles) {
    if (declaredWide) {
      // Declared-wide Stories still surface the width as advisory signal.
      out.push(
        makeSoftWidth(story.slug, 'fileCount', fileCount, sizing.softFiles),
      );
    } else {
      // Wide footprint with no `wide` declaration: informational nudge to
      // either merge the Story down (cohesion) or declare `wide` with a reason.
      out.push({
        kind: 'wide-undeclared',
        severity: 'soft',
        ticketSlug: story.slug,
        fileCount,
        softFiles: sizing.softFiles,
      });
    }
  }

  return out;
}

/**
 * Compute the full structured findings array for a normalized ticket
 * hierarchy. The validator stitches this onto its return value as
 * `findings`; the AC-visible `errors[]` channel is the rendered
 * subset where `severity === 'hard'`.
 *
 * 2-tier (Epic #3238): each Story is its own implementation unit and
 * carries the `body` (acceptance / changes / wide) that the sizing layers
 * score. There is no Task tier, so findings are computed directly over
 * `stories`.
 *
 * @param {{ stories: object[], sizing?: object }} input
 * @returns {object[]}
 */
export function computeSizingFindings({ stories, sizing }) {
  const merged = { ...DEFAULT_TASK_SIZING, ...(sizing ?? {}) };
  const findings = [];
  for (const story of stories ?? []) {
    findings.push(...computeStorySizingFindings(story, merged));
  }
  return findings;
}

/**
 * Render a structured hard finding as a human-readable error message.
 */
export function renderHardFindingError(finding) {
  if (finding.kind === 'oversized-task') {
    return `Task "${finding.ticketSlug}" exceeds the ${finding.field} ceiling: observed ${finding.observed}, max ${finding.ceiling}. Merge the Story down to one cohesive change, or declare \`wide\` with a one-line reason.`;
  }
  return `Task "${finding.ticketSlug}" tripped hard finding ${finding.kind}.`;
}
