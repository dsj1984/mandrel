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
 * Validate every task in `tickets` whose `body` is a structured object.
 * Returns an array of error strings (one per offending slug); empty array
 * means clean.
 *
 * @param {object[]} tickets
 * @returns {string[]}
 */
export function collectTaskBodyErrors(tickets) {
  const errors = [];
  for (const t of tickets) {
    if (t.type !== 'task') continue;
    const body = t.body;
    if (body == null || typeof body === 'string') continue;
    if (typeof body !== 'object') {
      errors.push(
        `Task "${t.title}" (${t.slug}): body must be an object, got ${typeof body}.`,
      );
      continue;
    }

    if (typeof body.goal !== 'string' || body.goal.trim() === '') {
      errors.push(
        `Task "${t.title}" (${t.slug}): body.goal must be a non-empty string.`,
      );
    }

    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (changes.length === 0) {
      errors.push(
        `Task "${t.title}" (${t.slug}): body.changes must list at least one bullet.`,
      );
    } else {
      const noPath = changes.filter(
        (c) => typeof c !== 'string' || !bulletNamesPath(c),
      );
      if (noPath.length === changes.length) {
        errors.push(
          `Task "${t.title}" (${t.slug}): body.changes bullets name no path-shaped token. Use "<path>: <verb> <object>" — e.g. "src/components/Foo.tsx: extract handleSubmit".`,
        );
      }
      for (const bullet of changes) {
        if (typeof bullet !== 'string') continue;
        const verb = vagueVerbWithoutTarget(bullet);
        if (verb) {
          errors.push(
            `Task "${t.title}" (${t.slug}): body.changes bullet uses vague verb "${verb}" without a named target: "${bullet}".`,
          );
        }
      }
    }

    const acceptance = Array.isArray(body.acceptance) ? body.acceptance : [];
    if (acceptance.length === 0) {
      errors.push(
        `Task "${t.title}" (${t.slug}): body.acceptance must list at least one criterion.`,
      );
    }

    const verify = Array.isArray(body.verify) ? body.verify : [];
    if (verify.length === 0) {
      errors.push(
        `Task "${t.title}" (${t.slug}): body.verify must list at least one entry. Use "manual:<reason>" only when truly unverifiable in isolation.`,
      );
    } else {
      for (const v of verify) {
        if (typeof v !== 'string') continue;
        if (v.startsWith('manual:')) {
          const reason = v.slice('manual:'.length).trim();
          if (reason === '') {
            errors.push(
              `Task "${t.title}" (${t.slug}): body.verify "manual:" entry has no reason after the colon.`,
            );
          }
        }
      }
    }
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
