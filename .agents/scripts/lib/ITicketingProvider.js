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
   * Fetch recent comments across the repository.
   * Useful for auditing and visualization of agent telemetry.
   *
   * @param {number} [limit=100]
   * @returns {Promise<object[]>}
   */
  async getRecentComments(_limit = 100) {
    throw new Error('Not implemented: getRecentComments');
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
   * Create a child ticket within an Epic's structural hierarchy.
   *
   * @param {number} parentId - GitHub Issue number of the immediate structural parent (e.g. Epic or Story).
   * @param {{
   *   epicId: number,
   *   title: string,
   *   body: string,
   *   labels: string[],
   *   dependencies: number[]
   * }} ticketData - The ticket content and metadata.
   * @returns {Promise<{ id: number, url: string }>}
   */

  /**
   * Link an existing issue as a sub-issue of a parent.
   *
   * @param {number} parentId - GitHub Issue number of the parent.
   * @param {number} childId - GitHub internal database ID of the sub-issue.
   * @returns {Promise<void>}
   */
  async addSubIssue(_parentId, _childId) {
    throw new Error('Not implemented: addSubIssue');
  }

  /**
   * Remove a sub-issue link from a parent.
   *
   * @param {number} parentId - GitHub Issue number of the parent.
   * @param {number} childId - GitHub internal database ID of the sub-issue.
   * @returns {Promise<void>}
   */
  async removeSubIssue(_parentId, _childId) {
    throw new Error('Not implemented: removeSubIssue');
  }

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

  /**
   * Open a Pull Request linking the specified ticket.
   *
   * @param {string} branchName - The source branch for the PR.
   * @param {number} ticketId - GitHub Issue number to link.
   * @returns {Promise<{ number: number, url: string, htmlUrl: string }>}
   */
  async createPullRequest(_branchName, _ticketId) {
    throw new Error('Not implemented: createPullRequest');
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
