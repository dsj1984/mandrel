/**
 * ColumnSync — collapse an issue's `agent::*` labels onto the stock Projects
 * v2 Status options (`Todo` / `In Progress` / `Done`) and push it via
 * GraphQL. Soft no-op when no project is configured, the Status field or
 * option is missing, or the issue is not on the board.
 */

import { AGENT_LABELS } from '../label-constants.js';
import {
  invalidateProjectMetaCache,
  readProjectMetaCache,
  writeProjectMetaCache,
} from './project-meta-cache.js';
import { resolveProjectMeta } from './project-meta-resolver.js';

export const LABEL_TO_COLUMN = Object.freeze({
  [AGENT_LABELS.REVIEW_SPEC]: 'Todo',
  [AGENT_LABELS.READY]: 'Todo',
  [AGENT_LABELS.EXECUTING]: 'In Progress',
  [AGENT_LABELS.CLOSING]: 'In Progress',
  [AGENT_LABELS.BLOCKED]: 'In Progress',
  [AGENT_LABELS.DONE]: 'Done',
});

/**
 * `done` wins, then any in-flight label, then parking labels; `null` when no
 * `agent::*` label is present.
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
   *   config?: object,
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
    // Locates the meta cache's tempRoot; absent means the default `temp`.
    this.config = opts.config ?? ctx?.config ?? undefined;
    this._meta = null; // lazy-cached { projectId, fieldId, options: Map<name, id> }
    // Disk-hydrated meta may be stale; a failed mutation then invalidates it.
    this._metaFromDiskCache = false;
  }

  /**
   * @param {number} issueId
   * @param {string[]} labels
   */
  async sync(issueId, labels) {
    const column = columnForLabels(labels);
    if (!column) return { status: 'skipped', reason: 'no-matching-label' };
    return this.setColumn(issueId, column);
  }

  /**
   * Set a column directly, without label derivation — for container Epics,
   * which carry no `agent::*` label by invariant.
   *
   * @param {number} issueId
   * @param {string} column Board column name (`Todo` | `In Progress` | `Done`).
   */
  async setColumn(issueId, column) {
    if (!column) return { status: 'skipped', reason: 'no-column' };
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

    try {
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
    } catch (err) {
      // Likely a reconfigured board: drop cached meta so the next flip
      // self-heals, and re-throw for the caller's handling.
      this.#invalidateMetaCache();
      throw err;
    }
    return { status: 'synced', column };
  }

  /**
   * Cache key; same owner `#loadMeta` resolves against.
   *
   * @returns {{ owner: string|null, projectNumber: number|null }}
   */
  get #cacheBoard() {
    return {
      owner: this.projectOwner ?? this.provider.owner ?? null,
      projectNumber: this.projectNumber,
    };
  }

  /**
   * Only disk-hydrated meta is invalidated; a fresh resolve that fails is a
   * live problem, not a stale cache.
   */
  #invalidateMetaCache() {
    if (!this._metaFromDiskCache) return;
    const { owner, projectNumber } = this.#cacheBoard;
    invalidateProjectMetaCache({ owner, projectNumber, config: this.config });
    this._meta = null;
    this._metaFromDiskCache = false;
  }

  async #loadMeta() {
    if (this._meta !== null) return this._meta || null;
    // Board meta is repo-invariant; the disk cache spares each cold CLI
    // process the resolve round-trips.
    const cachedBoard = this.#cacheBoard;
    const cached = readProjectMetaCache({
      owner: cachedBoard.owner,
      projectNumber: cachedBoard.projectNumber,
      config: this.config,
    });
    if (cached) {
      this._meta = cached;
      this._metaFromDiskCache = true;
      return this._meta;
    }
    try {
      // Shared org → user → viewer resolver; Status field in one round-trip.
      const project = await resolveProjectMeta({
        provider: this.provider,
        owner: this.projectOwner ?? this.provider.owner ?? null,
        projectNumber: this.projectNumber,
        projectFields: `
          id
          field(name: "Status") {
            ... on ProjectV2SingleSelectField {
              id
              options { id name }
            }
          }`,
      });
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
      // Best-effort; a write failure never blocks the sync.
      writeProjectMetaCache({
        owner: cachedBoard.owner,
        projectNumber: cachedBoard.projectNumber,
        meta: this._meta,
        config: this.config,
      });
      this._metaFromDiskCache = false;
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
   * Live Status column, or `null`. Drift checks must read this, not labels:
   * the Projects bot rewrites Status without touching labels.
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
    // Walk issue → projectItems, not board → items: scanning board items
    // hits a pagination cliff on large boards; an issue is on few boards.
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
