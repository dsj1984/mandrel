/**
 * Story sizing model — v2 model-capacity split advisory.
 *
 * Per-Story file/AC ceilings (`DEFAULT_TASK_SIZING.softFiles` /
 * `hardFiles` / `softAcceptanceCount`) are gone. A Story is sized by
 * **cohesion first**; the numeric backstop only asks whether the authored
 * Story ticket itself is pathologically verbose. See `docs/roadmap.md`
 * § v2.0.0 design decision 2.
 *
 * Co-located with `ticket-validator.js`, but kept as its own module so the
 * validator's primary file stays under the maintainability ceiling. The
 * validator imports `computeSizingFindings` and `renderHardFindingError` and
 * stitches the result onto its return value as `findings` / `errors`.
 *
 * `DEFAULT_MODEL_CAPACITY` is the **single source of truth** for the capacity
 * thresholds. The decomposer prompt template
 * (`.agents/scripts/lib/templates/decomposer-prompts.js`) generates its
 * threshold sentence from this constant rather than restating divergent
 * numbers, so the two surfaces cannot drift.
 *
 * Capacity model:
 *   - Plan-time **session mass** = authored tokens only (`estimateTokens` of
 *     the Story's goal/reason/acceptance/verify/slicing/spec/change paths).
 *   - Soft / hard ceilings are **absolute** authored-token counts (no
 *     `maxTokenBudget` denominator — that envelope was retired).
 *   - The optional `wide` declaration lifts the hard session-mass rejection.
 *   - Cohesion remains the primary heuristic; capacity is a pathological-
 *     verbosity backstop only (not an operator-tunable agentrc knob).
 */

import { parse as parseStoryBody } from '../story-body/story-body.js';
import { estimateTokens } from './context-envelope.js';

/**
 * Normalize a Story's `body` to the structured object the sizing layers
 * score, mirroring `validateAcFreshness` / `collectStoryAssumptionEntries`
 * (Story #3302) and `resolveStructuredBody` in `task-body-validator.js`.
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
 * authoritative top-level `story.acceptance` over the structured body's
 * `acceptance`.
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
 * Resolve the verify-commands array for a Story, preferring the top-level
 * `story.verify` over the structured body's `verify`.
 *
 * @param {object} story
 * @returns {unknown[]}
 */
function resolveVerify(story) {
  if (Array.isArray(story?.verify)) return story.verify;
  const body = resolveStoryBody(story);
  return Array.isArray(body?.verify) ? body.verify : [];
}

/**
 * Resolve the `depends_on` edge list for a Story.
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

/**
 * Framework capacity constant — not operator-tunable via `.agentrc.json`
 * (same collapse pattern as `maxTickets` / Story #4163).
 *
 * Absolute authored-token ceilings (no delivery-envelope denominator):
 *
 * - Soft 30_000: cohesion check when the ticket itself is already a
 *   substantial document. Normal capability Stories stay silent.
 * - Hard 75_000: reject Spec novels unless `wide`.
 * - Merge candidate 1_500: thin `depends_on` fragment (soft only).
 *
 * Cohesion / split policy / conflict advisories remain the primary sizing
 * signal; these ceilings catch pathological ticket verbosity only.
 */
export const DEFAULT_MODEL_CAPACITY = Object.freeze({
  softSessionTokens: 30000,
  hardSessionTokens: 75000,
  mergeCandidateMaxSessionTokens: 1500,
});

/**
 * Resolve capacity ceilings, shallow-merging an optional override bag
 * (tests / programmatic only). Pure; used by the validator and the
 * decomposer prompt.
 *
 * @param {object} [capacity]
 * @returns {{ softSessionTokens: number, hardSessionTokens: number, mergeCandidateMaxSessionTokens: number }}
 */
export function resolveCapacityCeilings(capacity = DEFAULT_MODEL_CAPACITY) {
  const merged = { ...DEFAULT_MODEL_CAPACITY, ...(capacity ?? {}) };
  return {
    softSessionTokens: merged.softSessionTokens,
    hardSessionTokens: merged.hardSessionTokens,
    mergeCandidateMaxSessionTokens: merged.mergeCandidateMaxSessionTokens,
  };
}

/**
 * `DELIVERABLE_GRANULARITY_GUIDANCE` is the **single source of truth** for the
 * deliverable-granularity definition of a Story (Story #3777). It is stated
 * ONCE here and consumed by BOTH the decomposer prompt template and the
 * authoring SKILL.
 */
export const DELIVERABLE_GRANULARITY_GUIDANCE = Object.freeze({
  definition:
    'A Story is a **capability slice a frontier model delivers and self-verifies in one pass** — a shippable slice a reviewer would accept as a single PR, a capability or user-visible surface, **not a single module or file**. Fold module-level slices into the capability they belong to rather than emitting one Story per module.',
  singleConsumerRule:
    '**Single-consumer merge rule.** A Story whose only consumer is one sibling Story should be **merged into that sibling** rather than emitted separately — a single-consumer downstream slice is not its own unit of work.',
  envelopeFloor:
    '**Thin dependent slices are a merge signal.** A Story that is neither parallel-deliverable nor orthogonal to its siblings — especially a short `depends_on` fragment whose only job is to feed one consumer — should be **merged into its consumer**. Modern frontier models one-shot capability-sized changes, so a chain of small dependent Stories needlessly pays a full delivery session (branch, PR, review, CI) per link. Merge such links up unless a parallelism or orthogonality reason justifies the separate slice.',
});

/**
 * `AUTHORING_ALTITUDE_GUIDANCE` is the **single source of truth** for the
 * binding-vs-advisory authoring altitude (Epic #4131 F8) and the New-File
 * Contract (Story #4272).
 */
export const AUTHORING_ALTITUDE_GUIDANCE = Object.freeze({
  altitude:
    '**Binding contract vs advisory sketch.** `acceptance[]` and `verify[]` are the Story\'s **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: your best prediction of the file footprint, which the executor MAY revise when the real codebase diverges from the sketch. Author `acceptance[]` / `verify[]` to assert the **outcome** independent of any one file layout — never pin an incidental implementation detail (an internal helper name, a private file path) into an acceptance item that the advisory `changes[]` is free to reshape; assert the observable behaviour instead.',
  advisoryCaveat:
    "**Advisory does not mean unvalidated.** `changes[]` paths still pass the base-branch file-assumption probes (a `creates` against an existing path still fails), the New-File Contract still holds, and the executor's latitude to revise the approach never licenses skipping `acceptance[]` / `verify[]` or relaxing any `rules/security-baseline.md` MUST.",
  newFileContract:
    '**New-File Contract.** Any path named in a Story\'s `goal`, `acceptance`, or `verify` that does NOT already exist on `main` MUST also appear in that Story\'s `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose — even when the Story is the one authoring the file.',
});

const UNANCHORED_CONSTANT_PATTERNS = Object.freeze([
  /\bretention window\b/i,
  /\brate[ -]limit\b/i,
  /\btimeout\b/i,
  /\bolder than\b/i,
  /\bwithin\b/i,
  /\bmax\b[^.]*\bper\b/i,
  /\bquota\b/i,
]);

const CONCRETE_VALUE_RE = /\d/;

function makeUnanchoredConstant(slug, criterion) {
  return {
    kind: 'unanchored-constant',
    severity: 'soft',
    ticketSlug: slug,
    criterion,
    message: `Acceptance criterion references a configuration constant without a concrete value: "${criterion}". Specify the value inline (e.g. "90 days", "5 req/s", "30 minutes") so the implementing agent doesn't have to read the Tech Spec or guess.`,
  };
}

function computeUnanchoredConstantFindings(story) {
  const out = [];
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

function makeMissingReasonToExist(slug) {
  return {
    kind: 'missing-reason-to-exist',
    severity: 'soft',
    ticketSlug: slug,
    message:
      'Story body carries no non-empty `reason_to_exist`. State the single coherent reason this Story exists in one sentence (the machine-checkable form of "one Story = one coherent change with one reason to exist"), encoded as the `reason_to_exist` field of the body meta comment.',
  };
}

function computeMissingReasonToExistFinding(story) {
  const body = resolveStoryBody(story);
  const reason = body?.reason_to_exist;
  const hasReason = typeof reason === 'string' && reason.trim().length > 0;
  return hasReason ? [] : [makeMissingReasonToExist(story.slug)];
}

function makeMergeCandidate(slug, sessionMass, dependsOn) {
  const siblings = dependsOn.map((d) => `"${d}"`).join(', ');
  return {
    kind: 'merge-candidate',
    severity: 'soft',
    ticketSlug: slug,
    sessionMass,
    dependsOn,
    message: `Story "${slug}" is a thin dependent slice (estimated session mass ${sessionMass} tokens) that depends on sibling(s) ${siblings}. A Story whose only role is to feed one sibling is not its own unit of work — consider merging it into the consumer (single-consumer merge rule) rather than shipping it as a separate slice.`,
  };
}

/**
 * Returns true when a `changes[]` entry is a glob pattern.
 */
function isGlobBullet(bullet) {
  const s = bullet?.path;
  return typeof s === 'string' && s.includes('*');
}

/**
 * Extract the path from a single object-form `changes` entry.
 */
function extractChangeBulletPath(bullet) {
  const s = bullet?.path ?? null;
  if (!s) return null;
  const colonIdx = s.indexOf(':');
  if (colonIdx <= 0) return /[\\/.]/.test(s) ? s.trim() : null;
  const head = s.slice(0, colonIdx).trim();
  return /[\\/.]/.test(head) ? head : null;
}

/**
 * Analyse the `changes[]` array and return fileCount / hasGlobs / path texts.
 */
function analyseChanges(changes) {
  const paths = new Set();
  const pathTexts = [];
  let hasGlobs = false;
  for (const bullet of changes) {
    if (isGlobBullet(bullet)) {
      hasGlobs = true;
      const globText = bullet?.path ?? '';
      if (globText) pathTexts.push(String(globText));
      continue;
    }
    const path = extractChangeBulletPath(bullet);
    if (path) {
      paths.add(path);
      pathTexts.push(path);
    }
  }
  return { fileCount: paths.size, hasGlobs, pathTexts };
}

/**
 * Estimate the plan-time session mass (tokens) for a Story.
 *
 * Session mass is **authored prose only** — `estimateTokens` of the Story's
 * goal / reason / acceptance / verify / slicing / spec / change-path text.
 * File count and AC count do not add delivery-cost proxies (those recreated
 * the retired count ceilings). Glob entries contribute their text but do not
 * imply known width.
 *
 * @param {object} story
 * @param {object} [_capacity] Unused; retained so call sites that still pass
 *   a capacity bag keep working. Mass no longer depends on capacity knobs.
 * @returns {{ sessionMass: number, authoredTokens: number, acceptanceCount: number, fileCount: number, hasGlobs: boolean, changesAnalysis: object }}
 */
export function estimateStorySessionMass(
  story,
  _capacity = DEFAULT_MODEL_CAPACITY,
) {
  const body = resolveStoryBody(story);
  const acceptance = resolveAcceptance(story);
  const verify = resolveVerify(story);
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  const changesAnalysis = analyseChanges(changes);

  const authoredParts = [
    body?.goal,
    body?.reason_to_exist,
    typeof body?.spec === 'string' ? body.spec : '',
    ...acceptance.map((a) => String(a ?? '')),
    ...verify.map((v) => String(v ?? '')),
    typeof body?.slicing === 'string' ? body.slicing : '',
    ...changesAnalysis.pathTexts,
  ].filter((p) => typeof p === 'string' && p.length > 0);

  const authoredTokens = estimateTokens(authoredParts.join('\n'));

  return {
    sessionMass: authoredTokens,
    authoredTokens,
    acceptanceCount: acceptance.length,
    fileCount: changesAnalysis.fileCount,
    hasGlobs: changesAnalysis.hasGlobs,
    changesAnalysis,
  };
}

function makeOversized(slug, observed, ceiling) {
  return {
    kind: 'oversized-task',
    severity: 'hard',
    ticketSlug: slug,
    field: 'sessionMass',
    observed,
    ceiling,
  };
}

function makeSoftSessionPressure(slug, observed, soft) {
  return {
    kind: 'soft-session-pressure',
    severity: 'soft',
    ticketSlug: slug,
    field: 'sessionMass',
    observed,
    soft,
  };
}

/**
 * Returns true when the Story declares itself `wide` with a non-empty reason.
 * A `wide` declaration lifts the hard session-mass rejection.
 */
function isDeclaredWide(wide) {
  return (
    wide !== null &&
    typeof wide === 'object' &&
    typeof wide.reason === 'string' &&
    wide.reason.trim().length > 0
  );
}

function computeMergeCandidateFinding(story, mass, ceilings) {
  if (mass.hasGlobs) return [];
  const dependsOn = resolveDependsOn(story);
  if (dependsOn.length === 0) return [];
  if (mass.sessionMass > ceilings.mergeCandidateMaxSessionTokens) return [];
  return [makeMergeCandidate(story.slug, mass.sessionMass, dependsOn)];
}

/**
 * Compute the hard + soft capacity findings for a single Story.
 */
function computeStorySizingFindings(story, capacity, ceilings) {
  const out = [];
  const body = resolveStoryBody(story);
  const declaredWide = isDeclaredWide(body?.wide ?? null);
  const mass = estimateStorySessionMass(story, capacity);

  out.push(...computeUnanchoredConstantFindings(story));
  out.push(...computeMissingReasonToExistFinding(story));
  out.push(...computeMergeCandidateFinding(story, mass, ceilings));

  // Glob entries mark the change footprint as unknown-width. A non-wide Story
  // carrying globs still gets an informational nudge to declare `wide` when
  // the authored mass alone does not already trip a capacity finding.
  if (mass.hasGlobs && !declaredWide) {
    out.push({
      kind: 'wide-undeclared',
      severity: 'soft',
      ticketSlug: story.slug,
      reason: 'glob-changes',
    });
  }

  const { softSessionTokens, hardSessionTokens } = ceilings;

  if (mass.sessionMass > hardSessionTokens && !declaredWide) {
    out.push(makeOversized(story.slug, mass.sessionMass, hardSessionTokens));
  } else if (mass.sessionMass > softSessionTokens) {
    if (declaredWide) {
      out.push(
        makeSoftSessionPressure(
          story.slug,
          mass.sessionMass,
          softSessionTokens,
        ),
      );
    } else {
      out.push({
        kind: 'wide-undeclared',
        severity: 'soft',
        ticketSlug: story.slug,
        sessionMass: mass.sessionMass,
        softSessionTokens,
      });
    }
  }

  return out;
}

/**
 * Compute the full structured findings array for a normalized ticket
 * hierarchy.
 *
 * @param {{ stories: object[], capacity?: object }} input
 * @returns {object[]}
 */
export function computeSizingFindings({ stories, capacity }) {
  const merged = {
    ...DEFAULT_MODEL_CAPACITY,
    ...(capacity ?? {}),
  };
  const ceilings = resolveCapacityCeilings(merged);
  const findings = [];
  for (const story of stories ?? []) {
    findings.push(...computeStorySizingFindings(story, merged, ceilings));
  }
  return findings;
}

/**
 * Render a structured hard finding as a human-readable error message.
 */
export function renderHardFindingError(finding) {
  if (finding.kind === 'oversized-task') {
    return `Story "${finding.ticketSlug}" exceeds the session-capacity ceiling: observed ${finding.observed} estimated tokens, max ${finding.ceiling}. Size the Story to what one guarded session can deliver and self-verify, or declare \`wide\` with a one-line reason.`;
  }
  return `Story "${finding.ticketSlug}" tripped hard finding ${finding.kind}.`;
}
