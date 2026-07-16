/**
 * Story body schema validator (v5.33+).
 *
 * Enforces the four-section structured body shape on 2-tier Stories emitted
 * by the decomposer. The canonical decomposition serializes every Story
 * `body` to a **markdown string** via `serialize()` from
 * `lib/story-body/story-body.js` (the decompose-author skill mandates this,
 * and `createOp` in `epic-spec-reconciler-ops.js` throws on an object body —
 * Story #3302). So at plan-time validation the Story body is a string, not an
 * object. To make the rules below actually fire on canonical plans, a string
 * body is **parsed** back into its structured form via `parseStoryBody`
 * before the section checks run (Story #3906 — previously the validator
 * `shouldSkipTicket`-skipped every string body, so the verify-tier suffix
 * rule, vague-verb check, and non-empty-goal check never ran on any real
 * decomposition). A still-structured object body (e.g. a caller that passes
 * the pre-serialize shape directly) is validated as-is.
 *
 * Only `type: 'story'` tickets are validated; Feature/Epic tickets and
 * null/empty bodies pass through. There is no `type::task` ticket layer in
 * the 2-tier hierarchy (Epic → Story).
 *
 * Required after parse/normalize: a non-empty `goal`, and non-empty
 * `changes`, `acceptance`, and `verify` arrays — and `changes` items must
 * name at least one path-shaped token so vague verbs ("clean up",
 * "refactor") can't slip through.
 *
 * `acceptance` / `verify` are the **top-level machine contract** (Story
 * #4541). The decomposer prompt tells authors to write those lists once at
 * the ticket's top level and omit the matching body sections; persist syncs
 * them into the body at assemble time. Validation runs *before* that sync,
 * so this validator resolves each contract field from the parsed body and
 * falls back to the ticket's top-level array when the body section is
 * absent. Without that fallback the validator rejected the very shape its
 * own prompt prescribes.
 *
 * `body.changes` items must be object-form `{ path: string, assumption: enum }`
 * entries (Story #2636 shape). Plain string bullets are rejected at parse
 * time and by this validator.
 *
 * Object-form items must declare an `assumption` ∈ `creates |
 * refactors-existing | exists | deletes`. The optional `body.references`
 * array uses the same object shape and is the home for paths the Story
 * reads but does not modify (test fixtures, sibling modules, etc.).
 *
 * `body.verify` entries must either name a testing tier in parentheses
 * drawn from `VERIFY_TIER_VALUES` (e.g. `npm run test (unit)`) or be the
 * literal `manual:<reason>` escape hatch when the Story is genuinely
 * unverifiable in isolation.
 *
 * The errors are batched and surfaced as a single thrown Error so the
 * planner can see every offending slug in one pass instead of fixing one
 * at a time.
 */

import {
  parse as parseStoryBody,
  StoryBodyParseError,
} from '../story-body/story-body.js';
import { FILE_ASSUMPTION_VALUES } from './file-assumption-enum.js';

/**
 * Canonical testing-tier labels that a `verify[]` entry must name (in
 * parentheses) to pass plan-time validation. Mirrors the verify-rules contract
 * in `.agents/scripts/lib/templates/decomposer-prompts.js`.
 *
 * Entries that do not end with `(<tier>)` and are not `manual:<reason>` are
 * rejected by `collectVerifyErrors`.
 */
export const VERIFY_TIER_VALUES = Object.freeze([
  'unit',
  'contract',
  'e2e',
  'validate',
]);

const PATH_LIKE_RE = /[/.][\w@\-./*]+|\*\*?\/?\*?\.\w+|[a-z][\w-]*\/[\w-./*]+/i;
const VAGUE_VERBS = [
  'clean up',
  'refactor',
  'improve',
  'polish',
  'tighten',
  'tidy',
  'simplify',
];

/**
 * @param {string} bullet
 * @returns {boolean}
 */
function bulletNamesPath(bullet) {
  const colonIdx = bullet.indexOf(':');
  if (colonIdx <= 0) return PATH_LIKE_RE.test(bullet);
  const head = bullet.slice(0, colonIdx);
  // The conventional shape is "<path>: <verb> <object>" — head is the path.
  return PATH_LIKE_RE.test(head) || PATH_LIKE_RE.test(bullet);
}

/**
 * @param {string} bullet
 * @returns {string|null} reason if the bullet uses a vague verb without a named target, else null.
 */
function vagueVerbWithoutTarget(bullet) {
  const lower = bullet.toLowerCase();
  for (const verb of VAGUE_VERBS) {
    if (!lower.includes(verb)) continue;
    if (!bulletNamesPath(bullet)) {
      return verb;
    }
  }
  return null;
}

/**
 * Predicate: should the validator skip this ticket entirely? Skip when:
 *   - it is not a Story (only `type: 'story'` tickets are validated here),
 *   - it has no body (null / undefined / empty-or-whitespace string — there
 *     is nothing to inspect).
 *
 * Under the 2-tier hierarchy (Epic → Story), Stories carry the
 * implementation scope inline. A canonical decomposition serializes the
 * Story body to a markdown string, so a *string* body is NOT skipped here
 * (Story #3906) — `validateTaskBodyShape` parses it back into structured
 * form via `parseStoryBody` before applying the section rules. This is what
 * makes the verify-tier / vague-verb / non-empty-goal checks actually fire
 * on real plans. Features (and everything else) use narrative string bodies
 * and are skipped by the `type !== 'story'` guard.
 *
 * Returns `true` when the ticket should be ignored by
 * `collectTaskBodyErrors`, `false` when the body should be inspected.
 *
 * @param {object} ticket
 * @returns {boolean}
 */
function shouldSkipTicket(ticket) {
  if (!ticket) return true;
  // Only Stories carry an inline implementation contract in the 2-tier
  // world. Features (and everything else) use narrative bodies.
  if (ticket.type !== 'story') return true;
  const body = ticket.body;
  if (body == null) return true;
  // An empty / whitespace-only string body carries no contract to inspect.
  if (typeof body === 'string' && body.trim() === '') return true;
  return false;
}

/**
 * Resolve a Story ticket's body to the structured object the section rules
 * operate on. A string body is the canonical serialized form — parse it via
 * `parseStoryBody` (Story #3906). An object body is already structured and
 * is returned verbatim (a caller may pass the pre-serialize shape directly).
 *
 * @param {object} ticket Story whose body passed `shouldSkipTicket`.
 * @returns {{ body: object|null, error: string|null }} `body` is the
 *   structured object when resolvable; `error` is a single message when a
 *   string body could not be parsed (mutually exclusive with `body`).
 */
function resolveStructuredBody(ticket) {
  const raw = ticket.body;
  if (typeof raw !== 'string') {
    return { body: raw, error: null };
  }
  const prefix = `Story "${ticket.title}" (${ticket.slug})`;
  try {
    return { body: parseStoryBody(raw).body, error: null };
  } catch (err) {
    const reason =
      err instanceof StoryBodyParseError ? err.message : String(err);
    return {
      body: null,
      error: `${prefix}: body string could not be parsed as a structured Story body: ${reason}`,
    };
  }
}

/**
 * The two contract fields that live at the ticket's top level and are
 * synced into the body by `plan-persist` at assemble time.
 */
const CONTRACT_FIELDS = Object.freeze(['acceptance', 'verify']);

/**
 * Resolve the body's contract fields against the ticket's top-level arrays
 * (Story #4541). The decomposer prompt prescribes authoring `acceptance[]`
 * / `verify[]` **once** at top level and omitting the matching body
 * sections; `assemblePlanStories#syncContractFieldFromTopLevel` performs
 * the sync, but it runs *after* validation. So an absent body section is
 * not a violation when the ticket carries the list at top level — it is the
 * preferred shape. A body section that is present and disagrees with the
 * top level is left alone here: the sync itself fails closed on that
 * mismatch, and duplicating the check would report it twice.
 *
 * @param {object} ticket
 * @param {object} bodyObject Parsed / structured body.
 * @returns {object} A copy of `bodyObject` with the contract fields resolved.
 */
function resolveContractFieldsFromTopLevel(ticket, bodyObject) {
  const resolved = { ...bodyObject };
  for (const field of CONTRACT_FIELDS) {
    const bodyValue = Array.isArray(resolved[field]) ? resolved[field] : [];
    if (bodyValue.length > 0) continue;
    const topLevel = Array.isArray(ticket?.[field]) ? ticket[field] : [];
    if (topLevel.length === 0) continue;
    resolved[field] = topLevel.map(String);
  }
  return resolved;
}

/**
 * Validate one Story body and return every violation it exhibits. Empty
 * array means clean. Splits the per-ticket cascade out of
 * `collectTaskBodyErrors` so the iteration stays straight-line and so
 * each section's defensive checks are independently testable.
 *
 * Accepts both the canonical **serialized string** body (parsed back into
 * structured form via `parseStoryBody` — Story #3906) and the
 * pre-serialize **structured object** body. A string body that cannot be
 * parsed surfaces a single error.
 *
 * @param {object} ticket Story whose `body` has already passed the
 *   `shouldSkipTicket` filter (i.e. `body` is a non-empty string or an
 *   object).
 * @returns {string[]}
 */
export function validateTaskBodyShape(ticket) {
  const prefix = `Story "${ticket.title}" (${ticket.slug})`;
  const { body: parsed, error } = resolveStructuredBody(ticket);
  if (error !== null) {
    return [error];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [`${prefix}: body must be an object, got ${typeof parsed}.`];
  }
  const body = resolveContractFieldsFromTopLevel(ticket, parsed);
  const errors = [];
  if (typeof body.goal !== 'string' || body.goal.trim() === '') {
    errors.push(`${prefix}: body.goal must be a non-empty string.`);
  }
  errors.push(...collectChangesErrors(prefix, body.changes));
  errors.push(...collectAcceptanceErrors(prefix, body.acceptance));
  // Tier-suffix validation is always enforced on Story bodies (2-tier world).
  errors.push(...collectVerifyErrors(prefix, body.verify));
  errors.push(...collectReferencesErrors(prefix, body.references));
  return errors;
}

/**
 * Predicate: is `entry` a well-formed object-form path entry? Returns
 * `true` only when it carries a non-empty `path` string and an
 * `assumption` from the canonical enum. Bare objects without these
 * fields surface as errors via `collectChangesErrors` /
 * `collectReferencesErrors`.
 *
 * @param {unknown} entry
 * @returns {entry is { path: string, assumption: typeof FILE_ASSUMPTION_VALUES[number] }}
 */
export function isObjectPathEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (typeof entry.path !== 'string' || entry.path.trim() === '') return false;
  if (!FILE_ASSUMPTION_VALUES.includes(entry.assumption)) return false;
  return true;
}

/**
 * Predicate: is `entry` an object that *looks* like the new shape but
 * has at least one invalid field? Distinct from `isObjectPathEntry` so
 * we can route bad objects through a specific error message instead of
 * silently collapsing them into the "name no path-shaped token" bucket.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isMalformedObjectPathEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (isObjectPathEntry(entry)) return false;
  // Anything that's an object and isn't a valid entry is malformed —
  // string-form bullets fall through this predicate (they're not objects).
  return true;
}

/**
 * @param {string} prefix
 * @param {unknown} rawChanges
 * @returns {string[]}
 */
function collectChangesErrors(prefix, rawChanges) {
  const changes = Array.isArray(rawChanges) ? rawChanges : [];
  if (changes.length === 0) {
    return [`${prefix}: body.changes must list at least one bullet.`];
  }
  const errors = [];
  const namesPath = (c) => isObjectPathEntry(c);
  if (changes.every((c) => !namesPath(c))) {
    errors.push(
      `${prefix}: body.changes must declare at least one { path, assumption } object entry.`,
    );
  }
  for (const entry of changes) {
    if (typeof entry === 'string') {
      errors.push(
        `${prefix}: body.changes entry must be a { path, assumption } object; plain string bullets are no longer accepted: "${entry}".`,
      );
      continue;
    }
    if (isMalformedObjectPathEntry(entry)) {
      errors.push(
        `${prefix}: body.changes object entry must declare { path: <string>, assumption: one of ${FILE_ASSUMPTION_VALUES.join('|')} }. Got: ${JSON.stringify(entry)}.`,
      );
    }
  }
  return errors;
}

/**
 * @param {string} prefix
 * @param {unknown} rawReferences
 * @returns {string[]}
 */
function collectReferencesErrors(prefix, rawReferences) {
  // `body.references` is optional — absent / null / undefined is fine.
  if (rawReferences === undefined || rawReferences === null) return [];
  if (!Array.isArray(rawReferences)) {
    return [
      `${prefix}: body.references must be an array of { path, assumption } objects when present, got ${typeof rawReferences}.`,
    ];
  }
  const errors = [];
  for (const entry of rawReferences) {
    if (!isObjectPathEntry(entry)) {
      errors.push(
        `${prefix}: body.references entry must declare { path: <string>, assumption: one of ${FILE_ASSUMPTION_VALUES.join('|')} }. Got: ${JSON.stringify(entry)}.`,
      );
    }
  }
  return errors;
}

/**
 * @param {string} prefix
 * @param {unknown} rawAcceptance
 * @returns {string[]}
 */
function collectAcceptanceErrors(prefix, rawAcceptance) {
  const acceptance = Array.isArray(rawAcceptance) ? rawAcceptance : [];
  if (acceptance.length === 0) {
    return [
      `${prefix}: acceptance must list at least one criterion — author it at the ticket's top level (preferred) or in the body's ## Acceptance section.`,
    ];
  }
  return [];
}

/**
 * Regex that matches a valid tier suffix at the end of a verify entry:
 * a parenthesised word drawn from `VERIFY_TIER_VALUES` (e.g. `(unit)`).
 * Whitespace before the opening paren is tolerated.
 */
const VERIFY_TIER_RE = new RegExp(
  `\\((?:${VERIFY_TIER_VALUES.join('|')})\\)\\s*$`,
);

/**
 * @param {string} prefix
 * @param {unknown} rawVerify
 * @returns {string[]}
 */
function collectVerifyErrors(prefix, rawVerify) {
  const verify = Array.isArray(rawVerify) ? rawVerify : [];
  if (verify.length === 0) {
    return [
      `${prefix}: verify must list at least one entry — author it at the ticket's top level (preferred) or in the body's ## Verify section. Use "manual:<reason>" only when truly unverifiable in isolation.`,
    ];
  }
  const errors = [];
  for (const v of verify) {
    if (typeof v !== 'string') continue;
    if (v.startsWith('manual:')) {
      const reason = v.slice('manual:'.length).trim();
      if (reason === '') {
        errors.push(
          `${prefix}: body.verify "manual:" entry has no reason after the colon.`,
        );
      }
      // manual: entries are exempt from the tier-suffix check.
      continue;
    }
    if (!VERIFY_TIER_RE.test(v)) {
      errors.push(
        `${prefix}: body.verify entry must end with a tier in parentheses — one of (${VERIFY_TIER_VALUES.join('|')}). Got: "${v}".`,
      );
    }
  }
  return errors;
}

/**
 * Validate every 2-tier Story in `tickets` whose `body` is a structured
 * object. Returns an array of error strings (one per offending slug); empty
 * array means clean.
 *
 * @param {object[]} tickets
 * @returns {string[]}
 */
export function collectTaskBodyErrors(tickets) {
  const errors = [];
  for (const ticket of tickets) {
    if (shouldSkipTicket(ticket)) continue;
    errors.push(...validateTaskBodyShape(ticket));
  }
  return errors;
}

/**
 * Throw a single batched error if any Story body is malformed; otherwise
 * return `tickets` unchanged.
 *
 * @param {object[]} tickets
 * @returns {object[]}
 */
export function validateTaskBodies(tickets) {
  const errs = collectTaskBodyErrors(tickets);
  if (errs.length === 0) return tickets;
  throw new Error(
    `[Decomposer] ${errs.length} story body schema violation(s):\n${errs.map((e) => `  - ${e}`).join('\n')}`,
  );
}
