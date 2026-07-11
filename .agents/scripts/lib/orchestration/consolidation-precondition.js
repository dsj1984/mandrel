/**
 * consolidation-precondition.js — deterministic dispatch gate for the Phase
 * 8.3 Holistic Consolidation sub-agent (Story #4431, Epic #4429).
 *
 * The Phase 8.3 consolidation critic (`epic-plan-consolidate`) is a genuine
 * fresh-context `Agent` dispatch — every call re-pays the full always-loaded
 * context (`.agents/instructions.md` and its always-on rules, § 4). When the
 * decomposer's draft `tickets.json` already matches the Tech Spec's `##
 * Delivery Slicing` target 1:1 (same shippable-Story count, and the
 * `depends_on` shape already agrees with each slice's declared
 * "Independent?" answer), there is nothing left for the critic to
 * reconcile — dispatching it is pure token spend for a no-op. This module
 * computes that decision **deterministically**, off the same two inputs the
 * critic itself reads (the draft array and the Epic body's Delivery Slicing
 * table), so `helpers/plan-epic.md` Phase 8.3 can skip the sub-agent
 * dispatch when it is provably safe to.
 *
 * **Fail-open by design.** Every ambiguous case — a missing or unparseable
 * Delivery Slicing section, an unparseable "Independent?" cell — resolves to
 * `dispatch: true`. This gate can only ever *save* a dispatch when it is
 * confident the critic has nothing to do; it never disables the critic's
 * ability to catch a real divergence. Phase 8.4 (reachability critic), 8.5
 * (pre-mortem critic), and the deterministic ticket validator are
 * unconditional — this precondition governs only the 8.3 dispatch.
 *
 * Pure, synchronous, no I/O — callers own reading `tickets.json` and the
 * Epic body off disk / the GitHub API.
 */

import { DELIVERY_SLICING_RE as DELIVERY_SLICING_HEADING_RE } from '../epic-body-sections.js';

/** A row is a markdown table line: starts with `|` once trimmed. */
const TABLE_ROW_RE = /^\|/;

/** A markdown table separator row: `|---|:---:|---:|` (dashes, colons, pipes only). */
const TABLE_SEPARATOR_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** The literal goal-section token that marks the wave-0 BDD scaffold Story. */
const BDD_SCAFFOLD_GOAL_TOKEN = 'bdd-scaffold';

/**
 * Split one markdown table row into trimmed cell strings.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Parse an "Independent?" cell per the pinned rule: match the cell's
 * leading word case-insensitively as `Yes` or `No`. Any other leading word
 * (or an empty cell) is unparseable and returns `null` — the caller must
 * fail open (`dispatch: true`) rather than guess.
 *
 * @param {string} cell
 * @returns {boolean|null} `true` for Yes, `false` for No, `null` when unparseable.
 */
function parseIndependentCell(cell) {
  const match = String(cell ?? '')
    .trim()
    .match(/^[A-Za-z]+/);
  if (!match) return null;
  const word = match[0].toLowerCase();
  if (word === 'yes') return true;
  if (word === 'no') return false;
  return null;
}

/**
 * Locate and parse the `## Delivery Slicing` markdown table out of the Epic
 * body (which carries the folded Tech Spec sections — Story #4324). Returns
 * `null` when the heading is absent, no table follows it, the table has no
 * "Independent?" column, or any data row's "Independent?" cell is
 * unparseable — every one of those is a fail-open signal for the caller.
 *
 * @param {string} epicBody
 * @returns {{ slice: string, independent: boolean }[] | null}
 */
export function parseDeliverySlicingTable(epicBody) {
  if (typeof epicBody !== 'string' || epicBody.length === 0) return null;

  const lines = epicBody.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) =>
    DELIVERY_SLICING_HEADING_RE.test(line.trim()),
  );
  if (headingIdx === -1) return null;

  let i = headingIdx + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !TABLE_ROW_RE.test(lines[i].trim())) return null;

  const headerCells = splitTableRow(lines[i]);
  i++;
  if (i >= lines.length || !TABLE_SEPARATOR_RE.test(lines[i].trim())) {
    return null;
  }
  i++;

  const independentIdx = headerCells.findIndex((cell) =>
    /independent/i.test(cell),
  );
  if (independentIdx === -1) return null;

  const rows = [];
  while (i < lines.length && TABLE_ROW_RE.test(lines[i].trim())) {
    const cells = splitTableRow(lines[i]);
    const independent = parseIndependentCell(cells[independentIdx]);
    if (independent === null) return null; // unparseable cell → fail open
    rows.push({ slice: (cells[0] ?? '').trim(), independent });
    i++;
  }

  return rows.length > 0 ? rows : null;
}

/**
 * True when `story` is the recognized wave-0 BDD scaffold Story — identified
 * by the literal `bdd-scaffold` goal token the `epic-plan-decompose-author`
 * skill's WAVE-0 BDD SCAFFOLD STORY section requires. Scaffold Stories are
 * not a Delivery Slicing slice, so they are excluded from the count
 * comparison — BDD-adopting consumer repos still benefit from the
 * precondition gate rather than always paying the 8.3 dispatch.
 *
 * @param {{ body?: unknown }} story
 * @returns {boolean}
 */
function isBddScaffoldStory(story) {
  const body = story?.body;
  return (
    typeof body === 'string' &&
    body.toLowerCase().includes(BDD_SCAFFOLD_GOAL_TOKEN)
  );
}

/**
 * Evaluate whether the Phase 8.3 consolidation sub-agent needs to run.
 *
 * @param {object} input
 * @param {object[]} input.draftStories - The draft `tickets.json` array
 *   (`epic-plan-decompose-author`'s output) — raw Story ticket objects with
 *   top-level `slug` / `depends_on` / `body` (serialized string).
 * @param {string} input.epicBody - The Epic body carrying the folded Tech
 *   Spec sections (`## Delivery Slicing` onward).
 * @returns {{ dispatch: boolean, reasons: string[] }} `dispatch: false` only
 *   when the draft matches the Delivery Slicing table 1:1 in count and
 *   dependency shape; `dispatch: true` (with `reasons`) otherwise, including
 *   every fail-open case.
 */
export function evaluateConsolidationPrecondition({ draftStories, epicBody }) {
  if (!Array.isArray(draftStories)) {
    throw new TypeError(
      'evaluateConsolidationPrecondition: draftStories must be an array',
    );
  }

  const slicing = parseDeliverySlicingTable(epicBody);
  if (!slicing) {
    return {
      dispatch: true,
      reasons: [
        'Delivery Slicing section is missing or unparseable — fail-open to the critic.',
      ],
    };
  }

  const slicedStories = draftStories.filter(
    (story) => !isBddScaffoldStory(story),
  );

  if (slicedStories.length !== slicing.length) {
    return {
      dispatch: true,
      reasons: [
        `Story count diverges from Delivery Slicing: ${slicing.length} proposed slice(s) vs ${slicedStories.length} non-scaffold draft Story(ies).`,
      ],
    };
  }

  const reasons = [];
  for (let idx = 0; idx < slicing.length; idx++) {
    const slice = slicing[idx];
    const story = slicedStories[idx];
    const dependsOn = Array.isArray(story?.depends_on) ? story.depends_on : [];
    const hasDeps = dependsOn.length > 0;
    const storyLabel = story?.slug ?? story?.title ?? `<story ${idx + 1}>`;

    if (slice.independent === false && !hasDeps) {
      reasons.push(
        `Slice "${slice.slice}" (position ${idx + 1}) is marked Independent: No but draft Story "${storyLabel}" declares no depends_on.`,
      );
    } else if (slice.independent === true && hasDeps) {
      reasons.push(
        `Slice "${slice.slice}" (position ${idx + 1}) is marked Independent: Yes but draft Story "${storyLabel}" declares depends_on [${dependsOn.join(', ')}].`,
      );
    }
  }

  if (reasons.length > 0) {
    return { dispatch: true, reasons };
  }

  return {
    dispatch: false,
    reasons: [
      `Draft matches Delivery Slicing 1:1 in count and dependency shape (${slicing.length} slice(s)) — skipping the 8.3 consolidation dispatch.`,
    ],
  };
}
