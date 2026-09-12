/**
 * pinned-identifier-lint.js — the `pinned-identifier` advisory lint over a
 * draft Story's `acceptance[]` (Story #5323).
 *
 * `acceptance[]` is the Story's **binding** contract and `changes[]` only an
 * advisory sketch the deliverer may revise, so an acceptance item naming an
 * internal symbol pins something the executor is free to rename out from
 * under it. The story-author prompt has always said so; nothing surfaced a
 * violation, which left the rule enforced only by the authoring model
 * remembering it.
 *
 * The classifier lives in its own module because its vocabulary is its own:
 * four token grammars and a call-suffix strip that the sibling prose lint in
 * `plan-text-hygiene.js` shares nothing with.
 *
 * Advisory by contract: findings are deterministic text for the persist
 * dry-run's warning list. They never gate persist and spawn nothing.
 *
 * Pure, synchronous, no I/O.
 *
 * @module lib/orchestration/pinned-identifier-lint
 */

/**
 * An inline code span carrying one of these is naming something other than a
 * source identifier, and is never a pinned identifier:
 *
 *   - `/` — a file path or a glob (`src/app.js`, `tests/x/*.spec.ts`);
 *   - `.` — a dotted path, a filename, or a config key
 *     (`delivery.routing.closeAndLand`, `story-body.js`);
 *   - `:` — a label (`agent::ready`, `type::story`);
 *   - `-` — a kebab token: a `data-testid` value, a slug, a package name, or
 *     a CLI flag (`--dry-run`);
 *   - whitespace — an argv shape, so a command (`npm run lint`);
 *   - `[` / `]` — a field reference (`acceptance[]`).
 */
const NON_IDENTIFIER_MARKERS = /[/.:\-\s[\]]/;

/** A bare source identifier, with an optional call suffix stripped. */
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * An UPPER_SNAKE token. Exempt by contract: an environment variable and an
 * internal constant are the same shape, and warning on every `DATABASE_URL`
 * to catch the occasional pinned constant trades a real class of false
 * positives for a marginal gain.
 */
const UPPER_SNAKE_RE = /^[A-Z0-9_$]+$/;

/**
 * A case transition (`staffCan`, `MyCalendarBoard`, `TimeGrid`) — the
 * signature that separates a source identifier from a prose word a criterion
 * legitimately quotes (`landed`, `pending`, `main`).
 */
const CASE_TRANSITION_RE = /[a-z][A-Z]/;

/** The remedy, either side of the identifiers a finding names. */
const MESSAGE_HEAD = 'Acceptance item pins the internal identifier(s) ';
const MESSAGE_TAIL =
  '; `changes[]` is an advisory sketch the deliverer may reshape, so assert ' +
  'the observable behaviour instead of the symbol that implements it.';

/**
 * Collect the inline code spans of one acceptance item.
 *
 * @param {string} item
 * @returns {string[]}
 */
function codeSpans(item) {
  return [...String(item ?? '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/**
 * Decide whether one code span pins a source identifier: a bare token
 * carrying a case transition, with no separator that would make it a path, a
 * label, a kebab token, a flag or a command, and not an UPPER_SNAKE name.
 *
 * Deliberately conservative in one direction only: a false positive costs a
 * warning line the author dismisses, while a false negative on a path, a
 * testid or a command would train the author to ignore the lint.
 *
 * @param {string} span
 * @returns {boolean}
 */
function isPinnedIdentifier(span) {
  const token = span.trim().replace(/\(\s*\)$/, '');
  return (
    !NON_IDENTIFIER_MARKERS.test(token) &&
    BARE_IDENTIFIER_RE.test(token) &&
    !UPPER_SNAKE_RE.test(token) &&
    CASE_TRANSITION_RE.test(token)
  );
}

/**
 * The authored `acceptance[]` of one draft Story.
 *
 * It is authored at the ticket's top level — the machine contract the
 * validators read — and synced into the body only at assembly, so the top
 * level wins; the parsed body covers a draft that carries it inline.
 *
 * @param {object} story The raw draft ticket.
 * @param {object} body Its parsed body.
 * @returns {string[]}
 */
function resolveAcceptance(story, body) {
  if (Array.isArray(story?.acceptance)) return story.acceptance;
  return Array.isArray(body?.acceptance) ? body.acceptance : [];
}

/**
 * Evaluate the lint over one draft Story — one finding per offending
 * acceptance item, naming every identifier it pinned.
 *
 * @param {object} story The raw draft ticket.
 * @param {object} body Its parsed body.
 * @param {string} slug
 * @param {(text: string) => string} excerpt Evidence truncator, shared with
 *   the sibling lints so every finding excerpts alike.
 * @returns {Array<{ kind: 'pinned-identifier', slug: string, evidence: string, message: string }>}
 */
export function findPinnedIdentifiers(story, body, slug, excerpt) {
  const acceptance = resolveAcceptance(story, body);
  const findings = [];
  for (const item of acceptance) {
    const pinned = codeSpans(item).filter(isPinnedIdentifier);
    if (pinned.length === 0) continue;
    const named = pinned.map((name) => `\`${name}\``).join(', ');
    findings.push({
      kind: 'pinned-identifier',
      slug,
      evidence: excerpt(String(item ?? '')),
      message: `${MESSAGE_HEAD}${named}${MESSAGE_TAIL}`,
    });
  }
  return findings;
}
