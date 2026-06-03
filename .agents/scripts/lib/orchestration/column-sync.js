/**
 * ColumnSync — derive the GitHub Projects v2 Status column from an issue's
 * agent:: labels, and push the update via the provider's GraphQL surface.
 *
 * The Status field carries only the three stock GitHub options
 * (`Todo` / `In Progress` / `Done`) — granular lifecycle state lives in the
 * `agent::*` labels themselves. This mapping collapses each lifecycle label
 * onto one of those three buckets:
 *
 *   agent::review-spec → Todo
 *   agent::ready       → Todo
 *   agent::executing   → In Progress
 *   agent::closing     → In Progress
 *   agent::blocked     → In Progress (the `agent::blocked` label is the
 *                       granular signal; the board column just shows the
 *                       work is still in flight)
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
  [AGENT_LABELS.REVIEW_SPEC]: 'Todo',
  [AGENT_LABELS.READY]: 'Todo',
  [AGENT_LABELS.EXECUTING]: 'In Progress',
  [AGENT_LABELS.CLOSING]: 'In Progress',
  [AGENT_LABELS.BLOCKED]: 'In Progress',
  [AGENT_LABELS.DONE]: 'Done',
});

/**
 * Pick the target column for a set of labels. Terminal `done` wins
 * unconditionally; otherwise any in-flight label (executing / closing /
 * blocked) collapses to `In Progress`, and parking labels (review-spec /
 * ready) collapse to `Todo`. Returns null when no `agent::*` label is
 * present so the caller can skip the sync.
 */
export function columnForLabels(labels) {
  const set = new Set(labels);
  if (set.has(AGENT_LABELS.DONE)) return 'Done';
  if (
    set.has(AGENT_LABELS.BLOCKED) ||
    set.has(AGENT_LABELS.EXECUTING) ||
    set.has(AGENT_LABELS.CLOSING)
  )
    return 'In Progress';
  if (set.has(AGENT_LABELS.READY) || set.has(AGENT_LABELS.REVIEW_SPEC))
    return 'Todo';
  return null;
}

export class ColumnSync {
  /**
   * @param {{
   *   provider: import('../ITicketingProvider.js').ITicketingProvider & { projectNumber?: number|null, projectOwner?: string|null, graphql: Function },
   *   projectNumber?: number | null,
   *   projectOwner?: string | null,
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
    this.projectOwner = opts.projectOwner ?? provider.projectOwner ?? null;
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
      let project;
      if (this.projectOwner) {
        // When the project is owned by a different account than the
        // authenticated viewer, `viewer.projectV2` returns null. Use
        // `user(login: $owner).projectV2` instead. (Story #3560)
        const data = await this.provider.graphql(
          `
          query($owner: String!, $number: Int!) {
            user(login: $owner) {
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
          { owner: this.projectOwner, number: this.projectNumber },
        );
        project = data?.user?.projectV2;
      } else {
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
        project = data?.viewer?.projectV2;
      }
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

  /**
   * Read the live `Status` column for an issue from the Projects v2
   * board. Returns the column name (e.g. `'Done'`, `'In Progress'`)
   * or `null` when the issue is not on the configured project, the
   * Status field has no current value, or the metadata cannot be
   * resolved.
   *
   * Story #2876 — used by `reassertStatusColumn` to detect drift
   * between the orchestrator's intended column and the bot-rewritten
   * column. The labels alone don't move when the bot overwrites
   * Status — that's the bug class we defend against — so the
   * drift-check MUST read the live Status, not the issue labels.
   *
   * @param {number} issueId
   * @returns {Promise<string|null>}
   */
  async readCurrentColumn(issueId) {
    if (!this.projectNumber) return null;
    const meta = await this.#loadMeta();
    if (!meta) return null;
    const itemId = await this.#getProjectItemId(issueId, meta.projectId);
    if (!itemId) return null;
    try {
      const data = await this.provider.graphql(
        `
        query($itemId: ID!) {
          node(id: $itemId) {
            ... on ProjectV2Item {
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }`,
        { itemId },
      );
      const name = data?.node?.fieldValueByName?.name;
      return typeof name === 'string' && name.length > 0 ? name : null;
    } catch (err) {
      this.logger.warn?.(
        `[ColumnSync] could not read current Status for issue #${issueId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  async #getProjectItemId(issueId, projectId) {
    // Walk from the issue to its projectItems and pick the one whose
    // project.id matches the configured board. The previous implementation
    // paginated `node(projectId).items(first: 100)` and scanned for the
    // issue number, which silently returned null on any board with >100
    // items — the Mandrel board crossed that cliff at ~2,300 items, so
    // every recent ticket's Status flip became a no-op. The by-issue path
    // is O(1) per sync and has no pagination cliff (an issue is
    // realistically never on more than a handful of boards at once).
    const owner = this.provider.owner;
    const repo = this.provider.repo;
    if (!owner || !repo) return null;
    const data = await this.provider.graphql(
      `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            projectItems(first: 20) {
              nodes {
                id
                project { id }
              }
            }
          }
        }
      }`,
      { owner, repo, number: issueId },
    );
    const nodes = data?.repository?.issue?.projectItems?.nodes ?? [];
    const match = nodes.find((n) => n?.project?.id === projectId);
    return match?.id ?? null;
  }
}
