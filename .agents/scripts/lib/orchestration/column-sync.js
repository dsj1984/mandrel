/**
 * ColumnSync — derive the GitHub Projects v2 Status column from an issue's
 * agent:: labels, and push the update via the provider's GraphQL surface.
 *
 * Mapping:
 *   agent::review-spec → Spec Review
 *   agent::ready       → Ready
 *   agent::executing   → In Progress
 *   agent::blocked     → Blocked
 *   agent::done        → Done
 *
 * No-op (soft fail) when:
 *   - `projectNumber` is not configured
 *   - The Status field or the required option is not present on the project
 *   - The issue is not a project item (e.g. orchestrator running on a fork)
 *
 * The sync is implemented as pure functions plus a thin class wrapper so
 * tests can pump a fake provider's `graphql` calls without touching live
 * GitHub.
 *
 * Located at `lib/orchestration/column-sync.js` (Story #2548) so the
 * canonical state mutator `transitionTicketState`
 * (`lib/orchestration/ticketing/state.js`) can invoke it without an
 * upward dependency into `epic-runner/`. Prior to #2548 this module
 * lived under `epic-runner/` and was only wired against the Epic
 * ticket — Stories and Tasks never updated their Projects v2 Status
 * column on label flips.
 */

import { AGENT_LABELS } from '../label-constants.js';

export const LABEL_TO_COLUMN = Object.freeze({
  [AGENT_LABELS.REVIEW_SPEC]: 'Spec Review',
  [AGENT_LABELS.READY]: 'Ready',
  [AGENT_LABELS.EXECUTING]: 'In Progress',
  [AGENT_LABELS.BLOCKED]: 'Blocked',
  [AGENT_LABELS.DONE]: 'Done',
});

/**
 * Pick the target column for a set of labels. Precedence:
 *   done > blocked > spec-review > ready > in-progress.
 * Terminal states win; the active blocker outranks execution.
 */
export function columnForLabels(labels) {
  const set = new Set(labels);
  if (set.has(AGENT_LABELS.DONE)) return 'Done';
  if (set.has(AGENT_LABELS.BLOCKED)) return 'Blocked';
  if (set.has(AGENT_LABELS.REVIEW_SPEC)) return 'Spec Review';
  if (set.has(AGENT_LABELS.READY)) return 'Ready';
  if (set.has(AGENT_LABELS.EXECUTING)) return 'In Progress';
  return null;
}

export class ColumnSync {
  /**
   * @param {{
   *   provider: import('../ITicketingProvider.js').ITicketingProvider & { projectNumber?: number|null, graphql: Function },
   *   projectNumber?: number | null,
   *   logger?: { info: Function, warn: Function },
   *   ctx?: { provider?: object, config?: { github?: { projectNumber?: number|null } }, logger?: object },
   * }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const provider = opts.provider ?? ctx?.provider;
    if (!provider) throw new TypeError('ColumnSync requires a provider');
    this.provider = provider;
    this.projectNumber =
      opts.projectNumber ??
      ctx?.config?.github?.projectNumber ??
      provider.projectNumber ??
      null;
    this.logger = opts.logger ?? ctx?.logger ?? console;
    this._meta = null; // lazy-cached { projectId, fieldId, options: Map<name, id> }
  }

  /**
   * Sync a single issue to its target column. Returns a result descriptor
   * (`synced | skipped | failed`) so callers can log without parsing errors.
   *
   * @param {number} issueId
   * @param {string[]} labels
   */
  async sync(issueId, labels) {
    const column = columnForLabels(labels);
    if (!column) return { status: 'skipped', reason: 'no-matching-label' };
    if (!this.projectNumber) {
      return { status: 'skipped', reason: 'no-project' };
    }

    const meta = await this.#loadMeta();
    if (!meta) return { status: 'skipped', reason: 'no-meta' };

    const optionId = meta.options.get(column);
    if (!optionId) {
      return { status: 'skipped', reason: `no-option-${column}` };
    }

    const itemId = await this.#getProjectItemId(issueId, meta.projectId);
    if (!itemId) return { status: 'skipped', reason: 'not-on-project' };

    await this.provider.graphql(
      `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId,
            itemId: $itemId,
            fieldId: $fieldId,
            value: { singleSelectOptionId: $optionId }
          }
        ) { projectV2Item { id } }
      }`,
      {
        projectId: meta.projectId,
        itemId,
        fieldId: meta.fieldId,
        optionId,
      },
    );
    return { status: 'synced', column };
  }

  async #loadMeta() {
    if (this._meta !== null) return this._meta || null;
    try {
      const data = await this.provider.graphql(
        `
        query($number: Int!) {
          viewer {
            projectV2(number: $number) {
              id
              field(name: "Status") {
                ... on ProjectV2SingleSelectField {
                  id
                  options { id name }
                }
              }
            }
          }
        }`,
        { number: this.projectNumber },
      );
      const project = data?.viewer?.projectV2;
      const field = project?.field;
      if (!project || !field) {
        this._meta = false;
        return null;
      }
      const options = new Map(field.options.map((o) => [o.name, o.id]));
      this._meta = {
        projectId: project.id,
        fieldId: field.id,
        options,
      };
      return this._meta;
    } catch (err) {
      this.logger.warn?.(
        `[ColumnSync] could not resolve project metadata: ${err?.message ?? err}`,
      );
      this._meta = false;
      return null;
    }
  }

  async #getProjectItemId(issueId, projectId) {
    const data = await this.provider.graphql(
      `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                content { ... on Issue { number } }
              }
            }
          }
        }
      }`,
      { projectId },
    );
    const nodes = data?.node?.items?.nodes ?? [];
    const match = nodes.find((n) => n?.content?.number === issueId);
    return match?.id ?? null;
  }
}
