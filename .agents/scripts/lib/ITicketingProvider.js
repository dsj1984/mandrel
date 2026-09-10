/**
 * ITicketingProvider — Abstract Ticketing Provider Interface
 *
 * All ticketing interactions in the v5 Story-centric orchestration are mediated
 * through this interface. Concrete implementations (e.g., `providers/github.js`)
 * extend this class and override every method.
 *
 * Unoverridden methods throw `Error('Not implemented: <method>')` to enforce
 * the contract at runtime rather than silently returning `undefined`.
 *
 * @see docs/architecture.md — Provider Abstraction Layer
 * @see docs/v5-implementation-plan.md Sprint 1A
 */

export class ITicketingProvider {
  // ---------------------------------------------------------------------------
  // Read Operations
  // ---------------------------------------------------------------------------

  /**
   * Fetch the Epic issue with its body — the single planning document
   * (ideation sections plus the folded Tech Spec / Acceptance Table
   * managed sections, Story #4324).
   *
   * @param {number} epicId - GitHub Issue number of the Epic.
   * @returns {Promise<{
   *   id: number,
   *   title: string,
   *   body: string,
   *   labels: string[]
   * }>}
   */
  async getEpic(_epicId) {
    throw new Error('Not implemented: getEpic');
  }
  /**
   * Fetch all child tickets for an Epic, optionally filtered by labels or state.
   *
   * @param {number} epicId - GitHub Issue number of the Epic.
   * @param {{ label?: string, state?: string }} [filters={}] - Filter criteria.
   * @returns {Promise<Array<{
   *   id: number,
   *   title: string,
   *   labels: string[],
   *   state: string
   * }>>}
   */
  async getTickets(_epicId, _filters = {}) {
    throw new Error('Not implemented: getTickets');
  }

  /**
   * Fetch all immediate sub-tickets of a given parent ticket.
   *
   * @param {number} parentId - GitHub Issue number of the parent.
   * @returns {Promise<Array<{
   *   id: number,
   *   title: string,
   *   labels: string[],
   *   state: string
   * }>>}
   */
  async getSubTickets(_parentId) {
    throw new Error('Not implemented: getSubTickets');
  }

  /**
   * Retrieve a single ticket with full metadata.
   *
   * @param {number} ticketId - GitHub Issue number.
   * @returns {Promise<{
   *   id: number,
   *   title: string,
   *   body: string,
   *   labels: string[],
   *   assignees: string[],
   *   state: string
   * }>}
   */
  async getTicket(_ticketId) {
    throw new Error('Not implemented: getTicket');
  }

  /**
   * Pre-populate the provider's per-instance ticket cache with a batch of
   * already-hydrated tickets so subsequent `getTicket(id)` calls can be
   * served from cache instead of issuing a REST round-trip.
   *
   * Default no-op: providers without a cache (e.g. the manual adapter or
   * test stubs) need not override. Call sites can therefore invoke
   * `provider.primeTicketCache(tickets)` unconditionally without an
   * `instanceof` / `typeof === 'function'` capability check.
   *
   * @param {Array<{ id: number }>} _tickets
   * @returns {void}
   */
  primeTicketCache(_tickets) {
    // Intentional no-op. Concrete providers that maintain a cache override.
  }

  /**
   * List every ticket carrying `labels`, in the **mapped** ticket shape.
   *
   * This is the declared read for a label scan, and the only one callers
   * should reach for. Implementations MUST map every issue the way every
   * other read on this interface does — in particular `id` is the **issue
   * number**, not the backend's internal database id.
   *
   * That single rule is the whole reason the method exists. The raw REST
   * payload names the issue number `number` and the database id `id`, so a
   * consumer handed either shape wrote `number ?? id` and appeared to cope —
   * while silently addressing issues by database id on the mapped shape,
   * because there `id` is already the number and the fallback never fires.
   * A declared shape removes the choice rather than documenting it.
   *
   * `state` selects `open` (default), `closed` or `all`. Implementations MUST
   * honour it: a caller asking for `all` is asking a question — "did this
   * child reopen?" — that an open-only listing answers wrongly rather than
   * partially.
   *
   * @param {{ state?: 'open'|'closed'|'all', labels?: string }} [_opts]
   * @returns {Promise<Array<{
   *   id: number,
   *   title: string,
   *   body: string,
   *   labels: string[],
   *   assignees: string[],
   *   state: string,
   *   url?: string|null,
   * }>>}
   */
  async listTicketsByLabel(_opts = {}) {
    throw new Error('Not implemented: listTicketsByLabel');
  }

  /**
   * Read a parent's native sub-issue children as issue numbers.
   *
   * Takes **both** identifiers because they address different things: the
   * backend's child edge is keyed by the parent's opaque node id, while
   * `number` exists only so a degraded read can name the parent it failed on.
   * Passing the number where the node id belongs is not a type error — it is
   * a successful call about the wrong issue — which is why the parameter
   * order is fixed here rather than left to each call site.
   *
   * Implementations MUST return `[]` rather than throw when the sub-issue
   * feature is unavailable on the backend: absence of the feature is not a
   * failed read, and callers union this with a body checklist that still
   * answers the question.
   *
   * @param {string} _nodeId Opaque node id of the parent.
   * @param {number} _number Parent's issue number, for diagnostics only.
   * @returns {Promise<number[]>}
   */
  async getNativeSubIssues(_nodeId, _number) {
    throw new Error('Not implemented: getNativeSubIssues');
  }

  /**
   * Resolve a ticket's container parent in **one** call.
   *
   * Exists so a child→parent lookup is a read, not a search. Without it the
   * only way to find a container was to list every candidate parent and read
   * each one's children — O(containers) requests to answer what the backend
   * knows directly.
   *
   * Returns `null` when the ticket has no parent, and `null` rather than
   * throwing when the backend cannot answer. Callers treat a null as "no
   * parent resolved *here*" and may fall back to a body-declared link; an
   * exception would turn a degraded lookup into a failed lifecycle edge.
   *
   * @param {number} _number Issue number whose parent to resolve.
   * @returns {Promise<object|null>} Mapped parent ticket, or null.
   */
  async getParentIssue(_number) {
    throw new Error('Not implemented: getParentIssue');
  }

  /**
   * Return the dependency graph edges for a ticket.
   * Parses `blocked by #NNN` patterns from the ticket body.
   *
   * @param {number} ticketId - GitHub Issue number.
   * @returns {Promise<{
   *   blocks: number[],
   *   blockedBy: number[]
   * }>}
   */
  async getTicketDependencies(_ticketId) {
    throw new Error('Not implemented: getTicketDependencies');
  }

  /**
   * Fetch all comments for a specific ticket.
   *
   * @param {number} ticketId - GitHub Issue number.
   * @returns {Promise<object[]>} Array of comment objects.
   */
  async getTicketComments(_ticketId) {
    throw new Error('Not implemented: getTicketComments');
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  /**
   * Mutate labels, body (tasklist checkboxes), and assignees on a ticket.
   *
   * @param {number} ticketId - GitHub Issue number.
   * @param {{
   *   labels?: { add?: string[], remove?: string[] },
   *   body?: string,
   *   assignees?: string[]
   * }} mutations - The mutations to apply.
   * @returns {Promise<void>}
   */
  async updateTicket(_ticketId, _mutations) {
    throw new Error('Not implemented: updateTicket');
  }

  /**
   * Append a structured comment to a ticket.
   *
   * @param {number} ticketId - GitHub Issue number.
   * @param {{
   *   body: string,
   *   type: 'progress'|'friction'|'notification'
   * }} payload - The comment content and classification.
   * @returns {Promise<{ commentId: number }>}
   */
  async postComment(_ticketId, _payload) {
    throw new Error('Not implemented: postComment');
  }

  /**
   * Delete an issue comment by its numeric id.
   * Implementations SHOULD treat "not found" as a no-op.
   *
   * @param {number} _commentId
   * @returns {Promise<void>}
   */
  async deleteComment(_commentId) {
    throw new Error('Not implemented: deleteComment');
  }

  // ---------------------------------------------------------------------------
  // Setup Operations (used by bootstrap)
  // ---------------------------------------------------------------------------

  /**
   * Idempotent label creation. Skips labels that already exist.
   *
   * @param {Array<{ name: string, color: string, description: string }>} labelDefs
   * @returns {Promise<{ created: string[], skipped: string[] }>}
   */
  async ensureLabels(_labelDefs) {
    throw new Error('Not implemented: ensureLabels');
  }

  /**
   * List the repository's whole label vocabulary.
   *
   * Implementations MUST paginate rather than take a fixed page cap: a cap is
   * silent truncation, and a caller deciding what to delete from a truncated
   * view is the exact failure Story #5189 exists to stop reproducing.
   *
   * @returns {Promise<Array<{ name: string, color: string|null, description: string|null }>>}
   */
  async listLabels() {
    throw new Error('Not implemented: listLabels');
  }

  /**
   * Delete one label by name.
   *
   * A label that is already gone MUST resolve as a successful no-op
   * (`{ deleted: false, reason: 'not-found' }`) rather than throwing, so a
   * re-run of any sweep built on this port is idempotent.
   *
   * @param {string} _name
   * @returns {Promise<{ deleted: boolean, reason: string|null }>}
   */
  async deleteLabel(_name) {
    throw new Error('Not implemented: deleteLabel');
  }

  /**
   * Idempotent custom field creation on the Project board.
   * Only applicable when `projectNumber` is configured.
   *
   * @param {Array<{
   *   name: string,
   *   type: 'single_select',
   *   options?: string[]
   * }>} fieldDefs
   * @returns {Promise<{ created: string[], skipped: string[] }>}
   */
  async ensureProjectFields(_fieldDefs) {
    throw new Error('Not implemented: ensureProjectFields');
  }

  /**
   * Execute a GraphQL query/mutation against the ticketing backend.
   * @param {string} _query - GraphQL query/mutation string.
   * @param {object} [_variables={}]
   * @param {object} [_opts={}]
   * @returns {Promise<object>} The `data` portion of the response.
   */
  async graphql(_query, _variables = {}, _opts = {}) {
    throw new Error('Not implemented: graphql');
  }

  /**
   * Inspect the branch-protection state of a branch. Returns
   * `{ enabled: false }` when no protection rule exists (HTTP 404), and
   * `{ enabled: true, raw }` when one does. Implementations may return a
   * richer shape; the only contract consumers rely on is the boolean.
   *
   * @param {string} _branch
   * @returns {Promise<{ enabled: boolean, raw?: object }>}
   */
  async getBranchProtection(_branch) {
    throw new Error('Not implemented: getBranchProtection');
  }

  /**
   * Create or additively-merge a branch-protection rule on `_branch`. The
   * `contexts` array names required status-check contexts; existing
   * contexts are preserved (additive merge). When no rule exists one is
   * created with sensible defaults and just the supplied contexts.
   *
   * Returns a summary `{ created, added, existing }` describing the diff
   * the bootstrap orchestrator surfaces to the operator. Implementations
   * MAY ignore other branch-protection knobs (PR review counts, signed
   * commits, etc.) so operator-tuned settings survive re-runs.
   *
   * @param {string} _branch
   * @param {{ contexts: string[], strict?: boolean }} _opts
   * @returns {Promise<{ created: boolean, added: string[], existing: string[] }>}
   */
  async setBranchProtection(_branch, _opts) {
    throw new Error('Not implemented: setBranchProtection');
  }

  /**
   * Read the repo's merge-method allowlist + auto-merge / delete-branch
   * flags. Returns a sparse object containing only the fields the upstream
   * API exposes (consumers should treat missing keys as "unknown").
   *
   * @returns {Promise<Partial<{
   *   allow_squash_merge: boolean,
   *   allow_rebase_merge: boolean,
   *   allow_merge_commit: boolean,
   *   allow_auto_merge: boolean,
   *   delete_branch_on_merge: boolean,
   * }>>}
   */
  async getMergeMethods() {
    throw new Error('Not implemented: getMergeMethods');
  }

  /**
   * PATCH the repo with the supplied merge-method settings. Body is sparse —
   * only the supplied fields are sent / touched.
   *
   * @param {Partial<{
   *   allow_squash_merge: boolean,
   *   allow_rebase_merge: boolean,
   *   allow_merge_commit: boolean,
   *   allow_auto_merge: boolean,
   *   delete_branch_on_merge: boolean,
   * }>} _settings
   * @returns {Promise<{ patched: string[] }>}
   */
  async setMergeMethods(_settings) {
    throw new Error('Not implemented: setMergeMethods');
  }
}
