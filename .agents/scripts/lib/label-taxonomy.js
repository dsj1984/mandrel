/**
 * Shared data structures for GitHub labels and custom fields.
 * Used by the bootstrap script to idempotently configure the project.
 *
 * All label names are sourced from `label-constants.js` so renames only need
 * to happen in one place. Colors come from `LABEL_COLORS` in the same module.
 *
 * v2 deleted the behavioral persona concept (`.agents/personas/` +
 * `persona::*` labels). Role framing for spawns lives in `.agents/agents/`
 * via `delivery.routing.roleScopedAgents`; QA auth identities live in
 * `qa.personas` — neither is a GitHub label axis.
 */

import {
  ACCEPTANCE_LABELS,
  AGENT_LABELS,
  LABEL_COLORS,
  PLANNING_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from './label-constants.js';

/** @type {Array<{ name: string, color: string, description: string }>} */
export const LABEL_TAXONOMY = [
  // Type
  {
    name: TYPE_LABELS.STORY,
    color: LABEL_COLORS.TYPE,
    description: 'Story work item',
  },

  // Agent State
  {
    name: AGENT_LABELS.REVIEW_SPEC,
    color: LABEL_COLORS.AGENT,
    description:
      'Parking state — Tech Spec exists; awaiting human review before decomposition',
  },
  {
    name: AGENT_LABELS.READY,
    color: LABEL_COLORS.AGENT,
    description:
      'Parking state — frozen dispatch manifest exists; awaiting local /deliver',
  },
  {
    name: AGENT_LABELS.EXECUTING,
    color: LABEL_COLORS.AGENT,
    description: 'Agent is working on this',
  },
  {
    name: AGENT_LABELS.CLOSING,
    color: LABEL_COLORS.AGENT,
    description: 'Close preflight passed; awaiting merge into the base branch',
  },
  {
    name: AGENT_LABELS.DONE,
    color: LABEL_COLORS.AGENT,
    description: 'Agent work completed',
  },

  // Status
  {
    name: STATUS_LABELS.BLOCKED,
    color: LABEL_COLORS.STATUS_BLOCKED,
    description: 'Blocked by a dependency',
  },

  // Acceptance axis — explicit opt-out signal for Epics that
  // intentionally have no acceptance-table coverage (waives the Epic
  // body's ## Acceptance Table section — Story #4324).
  {
    name: ACCEPTANCE_LABELS.N_A,
    color: LABEL_COLORS.ACCEPTANCE,
    description: 'No acceptance specification required',
  },

  // Planning axis — operator-applied waivers for the planning → delivery
  // handoff gates. `healthcheck-waived` remains for tickets that still
  // carry the historical label; the healthcheck CLI was retired.
  {
    name: PLANNING_LABELS.HEALTHCHECK_WAIVED,
    color: LABEL_COLORS.PLANNING,
    description:
      'Historical operator override for the retired post-plan healthcheck',
  },
];

/** @type {Array<{ name: string, type: 'single_select', options?: string[] }>} */
export const PROJECT_FIELD_DEFS = [
  {
    name: 'Execution',
    type: 'single_select',
    options: ['sequential', 'concurrent'],
  },
];

/**
 * Canonical lifecycle options for the Status single-select field. These are
 * the three stock GitHub Projects v2 options; granular lifecycle state lives
 * in the `agent::*` labels and `ColumnSync` collapses each label onto one of
 * these three buckets via `LABEL_TO_COLUMN` in
 * `lib/orchestration/column-sync.js`. Order matches the order options appear
 * on a fresh GitHub board.
 *
 * @type {string[]}
 */
export const STATUS_FIELD_OPTIONS = ['Todo', 'In Progress', 'Done'];
