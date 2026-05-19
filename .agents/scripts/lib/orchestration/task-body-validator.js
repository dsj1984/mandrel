/**
 * Task body schema validator (v5.33+).
 *
 * Enforces the four-section structured body shape on tasks emitted by the
 * decomposer. String-bodied or undefined-bodied tasks are skipped (legacy
 * fixtures + Feature/Story bodies pass through). When a task body IS a
 * structured object, we require non-empty `goal`, `changes`, `acceptance`,
 * and `verify` arrays — and that `changes` items name at least one
 * path-shaped token so vague verbs ("clean up", "refactor") can't slip
 * through.
 *
 * `body.changes` items may be either:
 *   1. A string bullet (legacy shape, e.g. `"src/foo.ts: extract handler"`).
 *   2. An object `{ path: string, assumption: enum }` (Story #2636 shape).
 *
 * Object-form items must declare an `assumption` ∈ `creates |
 * refactors-existing | exists | deletes`. The optional `body.references`
 * array uses the same object shape and is the home for paths the Task
 * reads but does not modify (test fixtures, sibling modules, etc.).
 * String-form `changes` items remain legal so legacy plans keep parsing,
 * but they emit a deprecation signal via `validateTaskFileAssumptions`.
 *
 * The errors are batched and surfaced as a single thrown Error so the
 * planner can see every offending slug in one pass instead of fixing one
 * at a time.
 */

/**
 * Canonical assumption values a path entry may declare. Mirrored in
 * {@link ./file-assumptions.js} where the runtime semantics live.
 */
export const FILE_ASSUMPTION_VALUES = Object.freeze([
  'creates',
  'refactors-existing',
  'exists',
  'deletes',
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
 *   - it is not a task,
 *   - its body is `null`/`undefined` (Feature/Story shape),
 *   - or its body is already a plain string (legacy fixture path).
 *
 * Returns `true` when the ticket should be ignored by
 * `collectTaskBodyErrors`, `false` when the body should be inspected.
 *
 * @param {object} ticket
 * @returns {boolean}
 */
function shouldSkipTicket(ticket) {
  if (!ticket || ticket.type !== 'task') return true;
  const body = ticket.body;
  return body == null || typeof body === 'string';
}

/**
 * Validate one structured task body and return every violation it
 * exhibits. Empty array means clean. Splits the per-task cascade out of
 * `collectTaskBodyErrors` so the iteration stays straight-line and so
 * each section's defensive checks are independently testable.
 *
 * @param {object} ticket Task whose `body` has already passed the
 *   `shouldSkipTicket` filter (i.e. `body` is an object-ish, non-string).
 * @returns {string[]}
 */
export function validateTaskBodyShape(ticket) {
  const body = ticket.body;
  const prefix = `Task "${ticket.title}" (${ticket.slug})`;
  if (typeof body !== 'object') {
    return [`${prefix}: body must be an object, got ${typeof body}.`];
  }
  const errors = [];
  if (typeof body.goal !== 'string' || body.goal.trim() === '') {
    errors.push(`${prefix}: body.goal must be a non-empty string.`);
  }
  errors.push(...collectChangesErrors(prefix, body.changes));
  errors.push(...collectAcceptanceErrors(prefix, body.acceptance));
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
  // An entry "names a path" when it is either a path-shaped bullet
  // string OR an object-form entry that passed the assumption schema.
  const namesPath = (c) => {
    if (typeof c === 'string') return bulletNamesPath(c);
    return isObjectPathEntry(c);
  };
  if (changes.every((c) => !namesPath(c))) {
    errors.push(
      `${prefix}: body.changes bullets name no path-shaped token. Use "<path>: <verb> <object>" — e.g. "src/components/Foo.tsx: extract handleSubmit". Object-form entries may also declare { path, assumption } directly.`,
    );
  }
  for (const entry of changes) {
    if (typeof entry === 'string') {
      const verb = vagueVerbWithoutTarget(entry);
      if (verb) {
        errors.push(
          `${prefix}: body.changes bullet uses vague verb "${verb}" without a named target: "${entry}".`,
        );
      }
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
    return [`${prefix}: body.acceptance must list at least one criterion.`];
  }
  return [];
}

/**
 * @param {string} prefix
 * @param {unknown} rawVerify
 * @returns {string[]}
 */
function collectVerifyErrors(prefix, rawVerify) {
  const verify = Array.isArray(rawVerify) ? rawVerify : [];
  if (verify.length === 0) {
    return [
      `${prefix}: body.verify must list at least one entry. Use "manual:<reason>" only when truly unverifiable in isolation.`,
    ];
  }
  const errors = [];
  for (const v of verify) {
    if (typeof v !== 'string') continue;
    if (!v.startsWith('manual:')) continue;
    const reason = v.slice('manual:'.length).trim();
    if (reason === '') {
      errors.push(
        `${prefix}: body.verify "manual:" entry has no reason after the colon.`,
      );
    }
  }
  return errors;
}

/**
 * Validate every task in `tickets` whose `body` is a structured object.
 * Returns an array of error strings (one per offending slug); empty array
 * means clean.
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
 * Throw a single batched error if any task body is malformed; otherwise
 * return `tickets` unchanged.
 *
 * @param {object[]} tickets
 * @returns {object[]}
 */
export function validateTaskBodies(tickets) {
  const errs = collectTaskBodyErrors(tickets);
  if (errs.length === 0) return tickets;
  throw new Error(
    `[Decomposer] ${errs.length} task body schema violation(s):\n${errs.map((e) => `  - ${e}`).join('\n')}`,
  );
}
