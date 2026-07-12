/**
 * Shared data structures for GitHub labels and custom fields.
 * Used by the bootstrap script to idempotently configure the project.
 *
 * All label names are sourced from `label-constants.js` so renames only need
 * to happen in one place. Colors come from `LABEL_COLORS` in the same module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_LABELS,
  AGENT_LABELS,
  DELIVERY_LABELS,
  LABEL_COLORS,
  PERSONA_LABEL_PREFIX,
  PLANNING_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
} from './label-constants.js';

const PERSONAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'personas',
);

/**
 * Discover persona labels from `.agents/personas/*.md`. The filename
 * (without extension) is the label suffix — this is the same value the
 * context hydrator uses to resolve `persona::<name>` to its markdown file.
 */
function buildPersonaLabels() {
  return fs
    .readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort()
    .map((name) => ({
      name: `${PERSONA_LABEL_PREFIX}${name}`,
      color: LABEL_COLORS.PERSONA,
      description: `${name} persona`,
    }));
}

/** @type {Array<{ name: string, color: string, description: string }>} */
export const LABEL_TAXONOMY = [
  // Type
  {
    name: TYPE_LABELS.EPIC,
    color: LABEL_COLORS.TYPE,
    description: 'Epic-level work item',
  },
  {
    name: TYPE_LABELS.STORY,
    color: LABEL_COLORS.TYPE,
    description: 'User story under an Epic',
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
    description: 'Close preflight passed; awaiting merge into the Epic branch',
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

  // Persona — dynamically derived from .agents/personas/*.md
  ...buildPersonaLabels(),

  // Acceptance axis — explicit opt-out signal for Epics that
  // intentionally have no acceptance-table coverage (waives the Epic
  // body's ## Acceptance Table section — Story #4324).
  {
    name: ACCEPTANCE_LABELS.N_A,
    color: LABEL_COLORS.ACCEPTANCE,
    description: 'No acceptance specification required',
  },

  // Planning axis — operator-applied waivers for the planning → delivery
  // handoff gates. Currently the sole entry is the `healthcheck-waived`
  // override consumed by `plan-persist.js` when the inline healthcheck
  // (`runPlanHealthcheck`) returned `ok: false` for a reason the
  // operator has triaged and accepted.
  {
    name: PLANNING_LABELS.HEALTHCHECK_WAIVED,
    color: LABEL_COLORS.PLANNING,
    description:
      'Operator override — allows agent::ready handoff despite a failing post-plan healthcheck',
  },

  // Delivery routing — applied by `plan-persist.js` when the risk verdict
  // declares `deliveryShape: "single"` (Epic #4474 PR4). Inert until #4475
  // lands the deliver-side reader.
  {
    name: DELIVERY_LABELS.SINGLE,
    color: LABEL_COLORS.DELIVERY,
    description:
      'Single-delivery plan — no Story tree; the Delivery Slicing table is the audit trail (#4474/#4475)',
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
