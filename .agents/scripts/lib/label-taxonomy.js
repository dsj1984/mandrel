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
  AGENT_LABELS,
  CONTEXT_LABELS,
  EPIC_LABELS,
  EXECUTION_LABELS,
  LABEL_COLORS,
  PERSONA_LABEL_PREFIX,
  RISK_LABELS,
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
    name: TYPE_LABELS.FEATURE,
    color: LABEL_COLORS.TYPE,
    description: 'Feature under an Epic',
  },
  {
    name: TYPE_LABELS.STORY,
    color: LABEL_COLORS.TYPE,
    description: 'User story under a Feature',
  },
  {
    name: TYPE_LABELS.TASK,
    color: LABEL_COLORS.TYPE,
    description: 'Implementable task',
  },

  // Agent State
  {
    name: AGENT_LABELS.REVIEW_SPEC,
    color: LABEL_COLORS.AGENT,
    description:
      'Parking state — PRD + Tech Spec exist; awaiting human review before decomposition',
  },
  {
    name: AGENT_LABELS.READY,
    color: LABEL_COLORS.AGENT,
    description:
      'Parking state — frozen dispatch manifest exists; awaiting local /epic-execute',
  },
  {
    name: AGENT_LABELS.EXECUTING,
    color: LABEL_COLORS.AGENT,
    description: 'Agent is working on this',
  },
  {
    name: AGENT_LABELS.REVIEW,
    color: LABEL_COLORS.AGENT,
    description: 'Awaiting human review',
  },
  {
    name: AGENT_LABELS.DONE,
    color: LABEL_COLORS.AGENT,
    description: 'Agent work completed',
  },

  // Epic modifiers
  {
    name: EPIC_LABELS.AUTO_CLOSE,
    color: LABEL_COLORS.EPIC,
    description: 'Opt-in — autonomous review → retro → close + merge-to-main',
  },

  // Status
  {
    name: STATUS_LABELS.BLOCKED,
    color: LABEL_COLORS.STATUS_BLOCKED,
    description: 'Blocked by a dependency',
  },

  // Risk
  {
    name: RISK_LABELS.MEDIUM,
    color: LABEL_COLORS.RISK,
    description: 'Medium-risk change',
  },

  // Persona — dynamically derived from .agents/personas/*.md
  ...buildPersonaLabels(),

  // Context
  {
    name: CONTEXT_LABELS.PRD,
    color: LABEL_COLORS.CONTEXT,
    description: 'Product Requirements Document',
  },
  {
    name: CONTEXT_LABELS.TECH_SPEC,
    color: LABEL_COLORS.CONTEXT,
    description: 'Technical Specification',
  },

  // Execution
  {
    name: EXECUTION_LABELS.SEQUENTIAL,
    color: LABEL_COLORS.EXECUTION,
    description: 'Must execute sequentially',
  },
  {
    name: EXECUTION_LABELS.CONCURRENT,
    color: LABEL_COLORS.EXECUTION,
    description: 'Can execute concurrently',
  },
];

/** @type {Array<{ name: string, type: 'iteration'|'single_select', options?: string[] }>} */
export const PROJECT_FIELD_DEFS = [
  { name: 'Sprint', type: 'iteration' },
  {
    name: 'Execution',
    type: 'single_select',
    options: ['sequential', 'concurrent'],
  },
];

/**
 * Canonical lifecycle options for the Status single-select field. Order here
 * is the order they appear on the board; `ColumnSync` reads label → column
 * names that match these strings exactly.
 *
 * @type {string[]}
 */
export const STATUS_FIELD_OPTIONS = [
  'Backlog',
  'Planning',
  'Spec Review',
  'Ready',
  'In Progress',
  'Blocked',
  'Review',
  'Done',
];

/**
 * Default Projects V2 saved Views. Filter strings follow GitHub's Projects
 * search syntax (`label:`, `status:`, `assignee:`). Each is grouped by the
 * Status field to match the board's columnar layout.
 *
 * GitHub's GraphQL surface does not yet expose a public `createProjectV2View`
 * mutation; bootstrap attempts it best-effort and falls back to documenting
 * the filter strings in `docs/project-board.md` when the mutation is
 * unavailable.
 *
 * @type {Array<{ name: string, filter: string, groupBy: string }>}
 */
export const PROJECT_VIEW_DEFS = [
  {
    name: 'Epic Roadmap',
    filter: 'label:type::epic',
    groupBy: 'Status',
  },
  {
    name: 'Current Sprint',
    filter: 'label:type::story -status:Done',
    groupBy: 'Status',
  },
  {
    name: 'My Queue',
    filter: 'assignee:@me',
    groupBy: 'Status',
  },
];
