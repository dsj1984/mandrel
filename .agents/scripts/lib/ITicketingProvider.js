/**
 * Abstract ticketing provider. Implementations (e.g. `providers/github.js`)
 * override every method; unoverridden ones throw rather than return
 * `undefined`.
 */

export class ITicketingProvider {
  // Reads

  /**
   * @param {number} epicId
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
   * @param {number} epicId
   * @param {{ label?: string, state?: string }} [filters={}]
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
   * @param {number} parentId
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
   * @param {number} ticketId
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
   * Seed the ticket cache so later `getTicket` calls skip a round-trip. A
   * no-op by default, so callers need no capability check.
   *
   * @param {Array<{ id: number }>} _tickets
   * @returns {void}
   */
  primeTicketCache(_tickets) {}

  /**
   * List tickets carrying `labels` in the mapped shape: `id` MUST be the issue
   * number, never the backend database id (a raw-vs-mapped `number ?? id`
   * fallback silently addresses the wrong issue). `state` (default `open`)
   * MUST be honoured.
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
   * Native sub-issue children as issue numbers. The edge is keyed by node id;
   * passing the number there succeeds about the wrong issue. MUST return `[]`
   * when the backend lacks the feature (callers union a body checklist).
   *
   * @param {string} _nodeId Opaque node id of the parent.
   * @param {number} _number Parent's issue number, for diagnostics only.
   * @returns {Promise<number[]>}
   */
  async getNativeSubIssues(_nodeId, _number) {
    throw new Error('Not implemented: getNativeSubIssues');
  }

  /**
   * `null` means "no parent"; throws when the lookup cannot answer.
   *
   * @param {number} _number
   * @returns {Promise<object|null>}
   */
  async getParentIssue(_number) {
    throw new Error('Not implemented: getParentIssue');
  }

  /**
   * @param {number} ticketId
   * @returns {Promise<{
   *   blocks: number[],
   *   blockedBy: number[]
   * }>}
   */
  async getTicketDependencies(_ticketId) {
    throw new Error('Not implemented: getTicketDependencies');
  }

  /**
   * @param {number} ticketId
   * @returns {Promise<object[]>}
   */
  async getTicketComments(_ticketId) {
    throw new Error('Not implemented: getTicketComments');
  }

  // Writes

  /**
   * @param {number} ticketId
   * @param {{
   *   labels?: { add?: string[], remove?: string[] },
   *   body?: string,
   *   assignees?: string[]
   * }} mutations
   * @returns {Promise<void>}
   */
  async updateTicket(_ticketId, _mutations) {
    throw new Error('Not implemented: updateTicket');
  }

  /**
   * @param {number} ticketId
   * @param {{
   *   body: string,
   *   type: 'progress'|'friction'|'notification'
   * }} payload
   * @returns {Promise<{ commentId: number }>}
   */
  async postComment(_ticketId, _payload) {
    throw new Error('Not implemented: postComment');
  }

  /**
   * SHOULD treat "not found" as a no-op.
   *
   * @param {number} _commentId
   * @returns {Promise<void>}
   */
  async deleteComment(_commentId) {
    throw new Error('Not implemented: deleteComment');
  }

  // Setup (bootstrap)

  /**
   * @param {Array<{ name: string, color: string, description: string }>} labelDefs
   * @returns {Promise<{ created: string[], skipped: string[] }>}
   */
  async ensureLabels(_labelDefs) {
    throw new Error('Not implemented: ensureLabels');
  }

  /**
   * MUST paginate: a page cap silently truncates, and callers decide
   * deletions from this list.
   *
   * @returns {Promise<Array<{ name: string, color: string|null, description: string|null }>>}
   */
  async listLabels() {
    throw new Error('Not implemented: listLabels');
  }

  /**
   * An absent label MUST resolve `{ deleted: false, reason: 'not-found' }`,
   * never throw, so sweeps are idempotent.
   *
   * @param {string} _name
   * @returns {Promise<{ deleted: boolean, reason: string|null }>}
   */
  async deleteLabel(_name) {
    throw new Error('Not implemented: deleteLabel');
  }

  /**
   * Idempotent; only applicable when `projectNumber` is configured.
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
   * @param {string} _query
   * @param {object} [_variables={}]
   * @param {object} [_opts={}]
   * @returns {Promise<object>} The response's `data`.
   */
  async graphql(_query, _variables = {}, _opts = {}) {
    throw new Error('Not implemented: graphql');
  }

  /**
   * `{ enabled: false }` on 404; consumers rely only on the boolean.
   *
   * @param {string} _branch
   * @returns {Promise<{ enabled: boolean, raw?: object }>}
   */
  async getBranchProtection(_branch) {
    throw new Error('Not implemented: getBranchProtection');
  }

  /**
   * Additively merge required status-check `contexts` (creating the rule if
   * absent). Other protection knobs are left alone so operator tuning
   * survives re-runs.
   *
   * @param {string} _branch
   * @param {{ contexts: string[], strict?: boolean }} _opts
   * @returns {Promise<{ created: boolean, added: string[], existing: string[] }>}
   */
  async setBranchProtection(_branch, _opts) {
    throw new Error('Not implemented: setBranchProtection');
  }

  /**
   * Sparse: a missing key means "unknown".
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
   * Sparse PATCH: only supplied fields are touched.
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
