/**
 * GitHub label and project-field definitions the bootstrap applies
 * idempotently. Names and colors come from `label-constants.js`.
 */

import {
  ACCEPTANCE_LABELS,
  AGENT_LABELS,
  LABEL_COLORS,
  PLANNING_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from './label-constants.js';

/**
 * @type {Array<{ name: string, color: string, description: string }>}
 */
const TYPE_LABEL_ROWS = [
  [TYPE_LABELS.STORY, 'Story work item'],
  [TYPE_LABELS.EPIC, 'Container-only grouping ticket for child Stories'],
].map(([name, description]) => ({
  name,
  color: LABEL_COLORS.TYPE,
  description,
}));

/** @type {Array<{ name: string, color: string, description: string }>} */
export const LABEL_TAXONOMY = [
  ...TYPE_LABEL_ROWS,

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
      'Parking state — frozen dispatch manifest exists; awaiting local /mandrel-deliver',
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

  {
    name: STATUS_LABELS.BLOCKED,
    color: LABEL_COLORS.STATUS_BLOCKED,
    description: 'Blocked by a dependency',
  },

  {
    name: ACCEPTANCE_LABELS.N_A,
    color: LABEL_COLORS.ACCEPTANCE,
    description: 'No acceptance specification required',
  },

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
 * The stock Projects v2 options, in board order; `column-sync.js` collapses
 * each `agent::*` label onto one.
 *
 * @type {string[]}
 */
export const STATUS_FIELD_OPTIONS = ['Todo', 'In Progress', 'Done'];
