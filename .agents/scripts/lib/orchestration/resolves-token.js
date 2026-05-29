/**
 * resolves-token.js — single source of truth for the `(resolves #N)`
 * Story-merge integration marker.
 *
 * Background. `story-close.js` integrates each Story branch into its
 * parent Epic branch with `git merge --no-ff` and a Conventional-Commit
 * subject that carries a ` (resolves #<storyId>)` trailer. That trailer is
 * the *durable* proof a Story landed on `epic/<id>`: the local/remote
 * Story branch is deleted right after the merge, and a later rebase or
 * force-push can drop the Story tip off the merged history, so several
 * recovery and telemetry paths grep the Epic log for the trailer rather
 * than relying on a branch ref.
 *
 * Before this module, six call sites each re-derived the marker inline —
 * three subtly different regexes (`/\(resolves #(\d+)\)/i`,
 * `/\(resolves\s+#\d+\)/i`) and three subtly different `git log --grep`
 * argument shapes (plain `resolves #N`, and the boundary-safe
 * `-E --grep=resolves #N( |\)|$)`). This module collapses them into one
 * token vocabulary with no change to the *emitted* text, so in-flight
 * peer closes that already wrote ` (resolves #N)` keep matching.
 *
 * Exports:
 *   - `resolvesToken(storyId)`       — the ` (resolves #<id>)` suffix that
 *                                      merge-subject.js appends to the
 *                                      merge-commit subject.
 *   - `RESOLVES_TRAILER_RE`          — anchored, capturing regex matching
 *                                      `(resolves #<digits>)` in a subject.
 *   - `parseResolvesStoryId(subject)`— parse the Story id out of a subject,
 *                                      or `null` when no trailer is present.
 *   - `resolvesGrepArgs(storyId)`    — the boundary-safe `git log` argument
 *                                      list (`['-E', '--grep=...']`) that
 *                                      matches the trailer for exactly this
 *                                      Story id and not a longer id that
 *                                      shares the prefix.
 *   - `resolvesOrRefsGrepArgs(storyId)` — like `resolvesGrepArgs` but matches
 *                                      the fully-parenthesized `(resolves #N)`
 *                                      *or* `(refs #N)` integration marker, for
 *                                      the ref-independent already-merged scan
 *                                      in `story-close-recovery.js`.
 *
 * Pure module — no I/O, no git spawns. Callers own the spawn.
 */

/**
 * Build the durable Story-merge marker suffix.
 *
 * The leading space is intentional: the marker is appended to a
 * Conventional-Commit subject (`<type>(<scope>): <title>`) and the space
 * separates the title from the trailer. This is the exact text peer
 * closes already emit — do not change it without a coordinated cutover of
 * every grep below.
 *
 * @param {number|string} storyId
 * @returns {string} ` (resolves #<storyId>)`
 */
export function resolvesToken(storyId) {
  return ` (resolves #${storyId})`;
}

/**
 * Match `(resolves #<digits>)` in a commit subject. Anchored to the
 * parenthesized form because that is the canonical Story-merge trailer
 * shape — a bare `resolves #N` mentioned in prose elsewhere in the
 * message must not win over the trailer. Capturing group 1 is the
 * Story id digits.
 *
 * Case-insensitive to tolerate a hand-authored `(Resolves #N)`; the
 * runtime always emits lower-case.
 *
 * @type {RegExp}
 */
export const RESOLVES_TRAILER_RE = /\(resolves #(\d+)\)/i;

/**
 * Parse the Story id out of a commit subject's `(resolves #N)` trailer.
 * Returns the integer id, or `null` when the subject carries no trailer.
 *
 * @param {string} subject
 * @returns {number|null}
 */
export function parseResolvesStoryId(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return null;
  const m = RESOLVES_TRAILER_RE.exec(subject);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Build the boundary-safe `git log --grep` argument list that matches the
 * `(resolves #<storyId>)` trailer for *exactly* this Story id.
 *
 * The trailing `( |\)|$)` alternation is what makes the match boundary
 * safe: `resolves #12` must not match a subject that names `#1234`. The
 * canonical merge subject closes the trailer with `)`, so the `\)` branch
 * is the common hit; the ` ` and `$` branches tolerate non-canonical
 * placements (trailer mid-subject, or unterminated at end-of-line).
 *
 * Returned as an argument array (not a string) so callers splat it
 * straight into a `git log` spawn alongside their own ref / format flags.
 * `-E` enables the POSIX-extended alternation.
 *
 * @param {number|string} storyId
 * @returns {string[]} `['-E', '--grep=resolves #<storyId>( |\\)|$)']`
 */
export function resolvesGrepArgs(storyId) {
  return ['-E', `--grep=resolves #${storyId}( |\\)|$)`];
}

/**
 * Build the boundary-safe `git log --grep` argument list that matches the
 * fully-parenthesized `(resolves #<storyId>)` *or* `(refs #<storyId>)`
 * integration marker for *exactly* this Story id.
 *
 * Unlike {@link resolvesGrepArgs} (which keys off a trailing space / paren /
 * end boundary), this matcher requires the canonical parenthesized form on
 * both sides — `\(...\)` — because it is the ref-independent already-merged
 * signal: when both Story refs are reaped, `story-close-recovery.js` scans
 * the Epic history for the integration commit whose subject carries the
 * trailer. The closing `\)` is the boundary that prevents `#3327` matching
 * `(resolves #33270)`. `refs` is accepted alongside `resolves` because an
 * agent-authored implementation commit references the Story via `(refs #N)`.
 *
 * @param {number|string} storyId
 * @returns {string[]} `['-E', '--grep=\\((resolves|refs) #<storyId>\\)']`
 */
export function resolvesOrRefsGrepArgs(storyId) {
  return ['-E', `--grep=\\((resolves|refs) #${storyId}\\)`];
}
