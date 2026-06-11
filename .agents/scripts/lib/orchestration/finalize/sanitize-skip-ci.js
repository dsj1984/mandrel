// .agents/scripts/lib/orchestration/finalize/sanitize-skip-ci.js
/**
 * sanitize-skip-ci.js — pure helper that strips GitHub Actions
 * `[skip ci]` markers (and the four variant spellings GitHub honours)
 * from a text payload.
 *
 * Story #3165: `/deliver` Phase 7 opens a PR squashed into `main`
 * via `gh pr merge --squash`. Story commits legitimately carry
 * `[skip ci]` markers under `delivery.ci.skipForStoryPushes: true` to
 * keep CI from firing on the wave's intermediate pushes. When GitHub
 * composes the squash commit body by concatenating constituent commit
 * messages, those markers propagate into the squash body and suppress
 * `ci.yml` + `release-please.yml` on `main` — even though the squash
 * subject is just `Epic #<id> (#<pr>)`.
 *
 * The first defence is to ensure the PR body (assembled by
 * `openOrLocatePr` and handed to `gh pr create`) carries no raw
 * skip-ci markers, so any tooling that derives the squash body from
 * the PR body (or from text that flows through this helper) cannot
 * re-introduce the suppression.
 *
 * Markers stripped (case-insensitive, optional inner spaces, optional
 * brackets per GitHub's documented contract — only the bracketed
 * forms actually suppress CI, so those are the only forms removed):
 *
 *   - `[skip ci]`     / `[ci skip]`
 *   - `[no ci]`
 *   - `[skip actions]` / `[actions skip]`
 *
 * Reference: GitHub Actions docs, "Skipping workflow runs":
 *   https://docs.github.com/en/actions/managing-workflow-runs/skipping-workflow-runs
 */

/**
 * Canonical regex list. Frozen so callers can introspect (e.g. a
 * contract test that asserts the documented marker set is what the
 * sanitizer actually matches) without mutating the SSOT.
 *
 * Each pattern matches the bracketed form only — bare `skip ci`
 * without brackets does NOT suppress CI on GitHub and is left
 * untouched.
 */
export const SKIP_CI_PATTERNS = Object.freeze([
  /\[\s*skip\s+ci\s*\]/gi,
  /\[\s*ci\s+skip\s*\]/gi,
  /\[\s*no\s+ci\s*\]/gi,
  /\[\s*skip\s+actions\s*\]/gi,
  /\[\s*actions\s+skip\s*\]/gi,
]);

/**
 * Strip every GitHub-recognised `[skip ci]` variant from `text`.
 *
 * Non-string input (null / undefined / number) is returned unchanged
 * so the helper can be folded into an optional-body assembly chain
 * without forcing the caller to guard.
 *
 * Multiple consecutive matches collapse cleanly:
 *   - Each matched marker is replaced with the empty string.
 *   - Runs of whitespace that the deletion leaves behind on the same
 *     line collapse to a single space.
 *   - Trailing whitespace on each line is trimmed.
 *   - Runs of three or more blank lines collapse to a single blank
 *     line (so a body that was nothing but markers doesn't leave a
 *     gaping vertical gap).
 *
 * The helper is intentionally idempotent: `sanitize(sanitize(x)) ===
 * sanitize(x)` for every input.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeSkipCiMarkers(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const pattern of SKIP_CI_PATTERNS) {
    out = out.replace(pattern, '');
  }
  // Collapse intra-line whitespace runs left behind by deletions, but
  // preserve line boundaries so paragraph structure survives.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n');
  // Collapse runs of 3+ blank lines down to one blank line.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}
