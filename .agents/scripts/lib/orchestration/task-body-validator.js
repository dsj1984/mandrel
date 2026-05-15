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
 * The errors are batched and surfaced as a single thrown Error so the
 * planner can see every offending slug in one pass instead of fixing one
 * at a time.
 */

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
  return errors;
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
  const noPath = changes.filter(
    (c) => typeof c !== 'string' || !bulletNamesPath(c),
  );
  if (noPath.length === changes.length) {
    errors.push(
      `${prefix}: body.changes bullets name no path-shaped token. Use "<path>: <verb> <object>" — e.g. "src/components/Foo.tsx: extract handleSubmit".`,
    );
  }
  for (const bullet of changes) {
    if (typeof bullet !== 'string') continue;
    const verb = vagueVerbWithoutTarget(bullet);
    if (verb) {
      errors.push(
        `${prefix}: body.changes bullet uses vague verb "${verb}" without a named target: "${bullet}".`,
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
