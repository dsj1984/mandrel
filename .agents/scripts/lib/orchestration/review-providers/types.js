/**
 * review-providers/types.js — Pluggable Code Review contract typedefs.
 *
 * Story #2825 (Epic #2815) — defines the `Finding` and `ReviewProvider`
 * shapes that adapters under `review-providers/` must conform to. The
 * factory loads an adapter, the adapter returns `Finding[]`, and the
 * `findings-renderer` turns that array into the structured-comment body
 * posted to the Story/Epic ticket.
 *
 * This file is JSDoc-only — no runtime exports. It exists so other
 * modules and tests have a single canonical reference to import via
 * `@typedef` lookups.
 *
 * @typedef {'critical'|'high'|'medium'|'suggestion'} Severity
 *
 * @typedef {object} Finding
 * @property {Severity} severity     - Severity tier; maps to the 🔴/🟠/🟡/🟢 emoji set.
 * @property {string}   title        - One-line summary.
 * @property {string}   body         - Markdown body rendered inside the comment.
 * @property {string=}  file         - Relative path, when attributable.
 * @property {number=}  line         - 1-based line number, when attributable.
 * @property {string=}  category     - Free-form tag (e.g. 'security', 'docs', 'lint').
 *
 * @typedef {'story'|'epic'} ReviewScope
 *
 * @typedef {object} ReviewInput
 * @property {ReviewScope} scope     - Which close boundary is invoking the review.
 * @property {number}      ticketId  - Story or Epic issue number.
 * @property {string}      baseRef   - Git ref to diff against (e.g. 'main', 'epic/2815').
 * @property {string}      headRef   - Git ref under review (e.g. 'story-2820', 'epic/2815').
 *
 * @typedef {object} ReviewProvider
 * @property {(input: ReviewInput) => Promise<Finding[]>} runReview
 */

export {};
