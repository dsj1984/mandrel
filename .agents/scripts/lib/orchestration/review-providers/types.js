/**
 * review-providers/types.js — the pluggable Code Review contract, as
 * `@typedef` lookups only (no runtime exports).
 *
 * @typedef {'critical'|'high'|'medium'|'suggestion'} Severity
 *
 * @typedef {object} Finding
 * @property {Severity} severity
 * @property {string}   title
 * @property {string}   body         - Markdown.
 * @property {string=}  file         - Relative path, when attributable.
 * @property {number=}  line         - 1-based, when attributable.
 * @property {string=}  category     - e.g. 'security', 'lint'.
 * @property {FindingClaim=} claim   - Structured, checkable claim.
 * @property {string=}  ungrounded   - Why a refuted critical was downgraded.
 * @property {string=}  unverified   - The verifier's reason for refuting a critical.
 * @property {string=}  context      - 'reviewed-with-truncated-context'.
 * @property {string=}  provider     - Chain entry that raised it.
 * @property {string=}  class        - Kebab-case bug class.
 * @property {{ file: string, line?: number }[]=} instances - Every location; the first is `file`/`line`.
 * @property {boolean=} repeat       - An earlier run of this Story raised it.
 *
 * @typedef {object} FindingClaim
 * @property {'path-absent'|'symbol-referenced'|'file-unchanged'} kind
 * @property {string=} path    - Absent or unchanged path, or the symbol's definition file.
 * @property {string=} symbol
 *
 * @typedef {'story'} ReviewScope
 *
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 *
 * @typedef {object} ReviewInput
 * @property {ReviewScope} scope
 * @property {number}      ticketId
 * @property {string}      baseRef
 * @property {string}      headRef
 * @property {ReviewDepth=} depth    - Diff-derived thoroughness lever; LLM-backed
 *   providers MUST render it into their prompt. Absent → `standard`.
 * @property {(string|null)=} guidance - Project review guidance; LLM-backed
 *   providers render it via `renderGuidanceBlock`.
 *
 * @typedef {object} ReviewProvider
 * @property {(input: ReviewInput) => Promise<Finding[]>} runReview
 *
 * Manual-prompt providers run no review; they contribute a one-line operator
 * suggestion for tools that cannot be invoked programmatically.
 *
 * @typedef {object} ManualPromptResult
 * @property {string} message
 *
 * @typedef {object} ManualPromptProvider
 * @property {(input: ReviewInput) => Promise<ManualPromptResult>} renderPrompt
 *
 * @typedef {object} ProviderGateContext
 * @property {ReviewScope}           scope
 * @property {ReadonlyArray<string>} labels
 *
 * @typedef {(ctx: ProviderGateContext) => boolean} ProviderGate
 *
 * @typedef {object} InlineChainEntry
 * @property {string}          name
 * @property {ReviewProvider}  provider
 * @property {ProviderGate}    gate      - false → skip this entry.
 *
 * @typedef {object} PromptChainEntry
 * @property {string}                name
 * @property {ManualPromptProvider}  provider
 * @property {ProviderGate}          gate
 *
 * @typedef {object} ProviderChain
 * @property {InlineChainEntry[]} inline
 * @property {PromptChainEntry[]} prompts
 */

export {};
