/**
 * task-graph-builder.js — Stage 4 of the story-init pipeline.
 *
 * Enumerates child Tasks of the Story, then topologically sorts them using
 * `blocked by` edges that reference other Tasks in the same set. Inter-Task
 * dependencies outside the child set are ignored (they are handled by the
 * Story-level blocker validator).
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { buildGraph, detectCycle, topologicalSort } from '../Graph.js';
import { Logger } from '../Logger.js';
import { fetchChildTickets } from '../story-lifecycle.js';

/**
 * Detect whether a Story body carries inline acceptance criteria, the
 * structural signal that the Story is authored in the 2-tier
 * (Story-with-inline-acceptance) shape and therefore should not be expected
 * to enumerate child Task tickets. Recognises both `## Acceptance` and
 * `## Acceptance Criteria` headings, with at least one list bullet under
 * them (mirroring the heading set the manifest-builder extracts).
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasInlineAcceptance(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const headingRe = /^##\s+Acceptance(?:\s+Criteria)?\s*$/im;
  const match = body.match(headingRe);
  if (!match || match.index == null) return false;
  const rest = body.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[-*]\s+(?:\[[ xX]\]\s+)?\S/.test(line)) return true;
  }
  return false;
}

function sortTasksByDependencies(tasks) {
  if (tasks.length <= 1) return tasks;

  const graphTasks = tasks.map((t) => ({
    ...t,
    dependsOn: parseBlockedBy(t.body ?? '').filter((dep) =>
      tasks.some((tt) => tt.id === dep),
    ),
  }));
  const { adjacency, taskMap } = buildGraph(graphTasks);

  const cycle = detectCycle(adjacency);
  if (cycle) {
    throw new Error(
      `[story-init] Dependency cycle detected among child tasks: ` +
        `#${cycle.join(' → #')}. Fix the \`blocked by\` references before retrying.`,
    );
  }

  return topologicalSort(adjacency, taskMap);
}

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.storyId
 * @param {string} [deps.input.storyBody]   Story body — used to detect
 *   whether the Story carries inline acceptance (2-tier shape) so the
 *   empty-Task-list path is treated as expected rather than as a warning.
 *
 * Task #3154 (Epic #3078) deleted the `planning.hierarchy` flag; the
 * 2-tier vs 4-tier mode is now derived entirely from the ticket shape —
 * inline acceptance + zero Tasks resolves to `'2-tier'`, otherwise
 * `'4-tier'`.
 *
 * @returns {Promise<{ sortedTasks: Array<object>, mode: '2-tier'|'4-tier' }>}
 */
export async function buildTaskGraph({ provider, logger, input }) {
  const { storyId, storyBody = '' } = input;
  const warn = logger?.warn ?? ((msg) => Logger.error(msg));
  const progress = logger?.progress ?? (() => {});

  const tasks = await fetchChildTickets(provider, storyId);

  const inlineAcceptance = hasInlineAcceptance(storyBody);
  const mode = tasks.length === 0 && inlineAcceptance ? '2-tier' : '4-tier';

  if (tasks.length === 0) {
    if (inlineAcceptance) {
      progress(
        'TASKS',
        `Story #${storyId} has inline acceptance — no child Tasks expected (2-tier shape).`,
      );
    } else {
      warn(
        `[story-init] Warning: Story #${storyId} has no child Tasks. The agent will need to work from the Story body directly.`,
      );
    }
  }

  const sortedTasks = sortTasksByDependencies(tasks);
  if (sortedTasks.length > 0) {
    progress(
      'TASKS',
      `Found ${sortedTasks.length} child Task(s) in dependency order`,
    );
  }

  return { sortedTasks, mode };
}

export { sortTasksByDependencies };
