/**
 * review-providers/types.js — Pluggable Code Review contract typedefs.
 *
 * Story #2825 (Epic #2815) — defines the `Finding` and `ReviewProvider`
 * shapes that adapters under `review-providers/` must conform to. The
 * factory loads an adapter, the adapter returns `Finding[]`, and the
 * `findings-renderer` turns that array into the structured-comment body
 * posted to the Story/Epic ticket.
 *
 * Story #2871 — extends the contract for multi-provider chains and
 * adds `ManualPromptProvider` for operator-prompt providers
 * (e.g. ultrareview) that emit a non-blocking suggestion into the
 * structured comment instead of running a real review.
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
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 *
 * @typedef {object} ReviewInput
 * @property {ReviewScope} scope     - Which close boundary is invoking the review.
 * @property {number}      ticketId  - Story or Epic issue number.
 * @property {string}      baseRef   - Git ref to diff against (e.g. 'main', 'epic/2815').
 * @property {string}      headRef   - Git ref under review (e.g. 'story-2820', 'epic/2815').
 * @property {ReviewDepth=} depth    - Risk-and-width-derived review thoroughness
 *   lever (Story #3876/#3937/#3938). `light` → single-pass review focused on
 *   Pillar 1 (spec adherence) with Pillars 2–3 reduced to a quick scan;
 *   `standard` → all pillars at baseline depth; `deep` → all pillars plus a
 *   second adversarial pass over the diff. Resolved from the judged risk
 *   envelope AND the changed-file count of the diff by `resolveDepth`
 *   (`lib/orchestration/review-depth.js`) and threaded into `runReview`.
 *   LLM-backed
 *   providers MUST render this into the prompt/instructions they emit; the
 *   native provider documents why its mechanical sweep ignores it. Absent →
 *   providers treat the review as `standard`.
 *
 * @typedef {object} ReviewProvider
 * @property {(input: ReviewInput) => Promise<Finding[]>} runReview
 *
 * Manual-prompt providers (Story #2871) do NOT run a review — they
 * contribute a one-line operator-facing suggestion to the structured
 * comment. Used for cloud or user-triggered review tools (e.g.
 * `/ultrareview`) that cannot be invoked programmatically from a
 * Node orchestrator.
 *
 * @typedef {object} ManualPromptResult
 * @property {string} message  - Markdown one-liner appended under "Manual review suggestions".
 *
 * @typedef {object} ManualPromptProvider
 * @property {(input: ReviewInput) => Promise<ManualPromptResult>} renderPrompt
 *
 * Chain entries (Story #2871) wrap an adapter with metadata used by
 * the orchestrator to gate invocation per-scope and per-label.
 *
 * @typedef {object} ProviderGateContext
 * @property {ReviewScope}           scope    - Current invocation scope.
 * @property {ReadonlyArray<string>} labels   - Ticket labels at invocation time.
 *
 * @typedef {(ctx: ProviderGateContext) => boolean} ProviderGate
 *
 * @typedef {object} InlineChainEntry
 * @property {string}          name      - Registered provider key (for logs/attribution).
 * @property {ReviewProvider}  provider  - Constructed inline adapter.
 * @property {ProviderGate}    gate      - Pure predicate; false → skip this entry.
 *
 * @typedef {object} PromptChainEntry
 * @property {string}                name      - Registered provider key.
 * @property {ManualPromptProvider}  provider  - Constructed manual-prompt adapter.
 * @property {ProviderGate}          gate      - Pure predicate; false → skip this entry.
 *
 * @typedef {object} ProviderChain
 * @property {InlineChainEntry[]} inline  - Inline adapters (run, merge Finding[]).
 * @property {PromptChainEntry[]} prompts - Manual-prompt adapters (render suggestion strings).
 */

export {};
