/**
 * The `--status` read model: environments with their load, and every Story
 * in a board column with the verdict each drop target would return. Drops
 * come from the same `decide` the command calls, so a board can never offer
 * a move the command refuses.
 *
 * @module lib/dispatch/status
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { agentStateOf, computeLoads, environmentOf } from './environments.js';
import { decide } from './verdict.js';

const COLUMNS = ['backlog', 'planning', 'ready', 'delivering', 'blocked'];
const DONE_LIMIT = 20;

const DELIVERING = new Set([AGENT_LABELS.EXECUTING, AGENT_LABELS.CLOSING]);

/**
 * @param {{ state?: string, labels?: string[] }} ticket
 * @returns {'backlog'|'planning'|'ready'|'delivering'|'blocked'|'done'|null}
 *   `null` for an open ticket no column shows (`agent::done` still open).
 */
function columnOf(ticket) {
  if (String(ticket.state ?? '').toLowerCase() === 'closed') return 'done';
  const state = agentStateOf(ticket.labels);
  if (state === null) return 'backlog';
  if (state === AGENT_LABELS.REVIEW_SPEC) return 'planning';
  if (state === AGENT_LABELS.BLOCKED) return 'blocked';
  if (DELIVERING.has(state)) return 'delivering';
  if (state === AGENT_LABELS.READY) {
    return environmentOf(ticket.labels) ? 'delivering' : 'ready';
  }
  return null;
}

/**
 * Counts over a `statusCheckRollup`.
 *
 * @param {Array<{ status?: string, conclusion?: string, state?: string }>} [rollup]
 * @returns {{ total: number, passed: number, failed: number, pending: number }}
 */
function checkSummary(rollup) {
  const summary = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const check of rollup ?? []) {
    summary.total += 1;
    const outcome = String(check.conclusion || check.state || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(outcome)) {
      summary.passed += 1;
    } else if (
      outcome === '' ||
      outcome === 'PENDING' ||
      outcome === 'EXPECTED'
    ) {
      summary.pending += 1;
    } else {
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * The action a drop of `story` onto environment `envName` would take: a
 * blocked Story resumes there, anything else is dispatched there.
 *
 * @param {object} story
 * @returns {'resume'|'dispatch'}
 */
function environmentDropAction(story) {
  return agentStateOf(story.labels) === AGENT_LABELS.BLOCKED
    ? 'resume'
    : 'dispatch';
}

/**
 * Each column and each environment mapped to that Story's verdict. Only the
 * `ready` column has a command behind it (`--stop`); the others are `null`.
 */
function dropsFor(story, ctx) {
  const base = {
    story,
    environments: ctx.environments,
    loads: ctx.loads,
    operator: ctx.operator,
    unmetDependencies: parseBlockedBy(story.body ?? '').filter((id) =>
      ctx.openIds.has(id),
    ),
  };
  const drops = Object.fromEntries(
    [...COLUMNS, 'done'].map((column) => [column, null]),
  );
  drops.ready = decide({ ...base, action: 'stop', envName: null });
  for (const env of ctx.environments) {
    drops[env.name] = decide({
      ...base,
      action: environmentDropAction(story),
      envName: env.name,
    });
  }
  return drops;
}

function prFor(storyId, prs) {
  const pr = prs.find((p) => p.headRefName === `story-${storyId}`);
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    checks: checkSummary(pr.statusCheckRollup),
  };
}

function storyRow(ticket, column, ctx) {
  return {
    id: ticket.id,
    title: ticket.title,
    column,
    state: agentStateOf(ticket.labels),
    environment: environmentOf(ticket.labels),
    pr: prFor(ticket.id, ctx.prs),
    dependsOn: parseBlockedBy(ticket.body ?? ''),
    drops: dropsFor(ticket, ctx),
  };
}

const isEpic = (ticket) => (ticket.labels ?? []).includes(TYPE_LABELS.EPIC);

/**
 * @param {{
 *   environments: import('./environments.js').Environment[],
 *   openTickets: object[],
 *   closedStories: object[],
 *   prs: object[],
 *   operator?: string|null,
 * }} board
 * @returns {{ environments: object[], stories: object[] }}
 */
export function buildStatus({
  environments,
  openTickets,
  closedStories,
  prs,
  operator = null,
}) {
  const loads = computeLoads(environments, openTickets);
  const ctx = {
    environments,
    loads,
    operator,
    prs: prs ?? [],
    openIds: new Set(openTickets.map((t) => t.id)),
  };
  const open = openTickets
    .filter((t) => !isEpic(t))
    .map((t) => [t, columnOf(t)])
    .filter(([, column]) => column !== null)
    .map(([t, column]) => storyRow(t, column, ctx));
  const done = [...closedStories]
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, DONE_LIMIT)
    .map((t) => storyRow(t, 'done', ctx));
  return {
    environments: environments.map((e) => ({
      name: e.name,
      target: e.target,
      capacity: e.capacity,
      load: loads[e.name],
      online: true,
    })),
    stories: [...open, ...done],
  };
}

/**
 * Live board data: every open issue, the most recently updated closed
 * Stories (one page, sorted by `closedAt` in {@link buildStatus}), and the
 * open pull requests with their checks.
 *
 * @param {{ provider: object, gh: object, config: object }} deps
 * @returns {Promise<{ openTickets: object[], closedStories: object[], prs: object[] }>}
 */
export async function fetchBoard({ provider, gh, config }) {
  const owner = config?.github?.owner ?? '{owner}';
  const repo = config?.github?.repo ?? '{repo}';
  const closedEndpoint =
    `/repos/${owner}/${repo}/issues?state=closed&labels=${encodeURIComponent(TYPE_LABELS.STORY)}` +
    '&sort=updated&direction=desc&per_page=50';
  const [openTickets, closedRaw, prs] = await Promise.all([
    provider.listTicketsByLabel({ state: 'open' }),
    gh.api({ endpoint: closedEndpoint }),
    gh.pr.list(
      ['--state', 'open', '--limit', '100'],
      ['number', 'url', 'headRefName', 'statusCheckRollup'],
    ),
  ]);
  const closedStories = JSON.parse(closedRaw.stdout || '[]')
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      id: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: (issue.labels ?? []).map((l) => l.name ?? l),
      assignees: (issue.assignees ?? []).map((a) => a.login),
      state: 'closed',
      closedAt: issue.closed_at ?? null,
    }));
  return { openTickets, closedStories, prs: Array.isArray(prs) ? prs : [] };
}

/**
 * A short human table of the same data `--status --json` returns.
 *
 * @param {{ environments: object[], stories: object[] }} status
 * @returns {string}
 */
export function renderStatus(status) {
  const lines = ['Environments:'];
  for (const env of status.environments) {
    lines.push(
      `  ${env.name.padEnd(16)} ${env.target.padEnd(8)} ${env.load}/${env.capacity}`,
    );
  }
  for (const column of [...COLUMNS, 'done']) {
    const rows = status.stories.filter((s) => s.column === column);
    if (rows.length === 0) continue;
    lines.push('', `${column} (${rows.length}):`);
    for (const s of rows) {
      const where = s.environment ? ` [${s.environment}]` : '';
      const pr = s.pr ? ` PR #${s.pr.number}` : '';
      lines.push(`  #${s.id}${where}${pr} ${s.title}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
