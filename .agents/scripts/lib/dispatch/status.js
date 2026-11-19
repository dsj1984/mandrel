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
import { columnForLabels } from '../orchestration/column-sync.js';
import { agentStateOf, computeLoads, environmentOf } from './environments.js';
import { launchChoices, overridesOf } from './launch-options.js';
import { readProjectStatuses } from './project-status.js';
import { decide } from './verdict.js';

const COLUMNS = ['backlog', 'planning', 'ready', 'delivering', 'blocked'];
/** The Done Stories `--done-limit` may ask for; the first default is 20. */
export const DONE_LIMITS = Object.freeze([10, 20, 50, 100]);
export const DEFAULT_DONE_LIMIT = 20;

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

/**
 * Whether `status` is the Project Status board-sync writes for the Story (a
 * closed Story expects `Done`); `null` with no Status read, or when no label
 * gives board-sync a Status to write.
 */
function statusMatchesOf(ticket, column, status) {
  const expected =
    column === 'done' ? 'Done' : columnForLabels(ticket.labels ?? []);
  return status && expected ? status === expected : null;
}

function storyRow(ticket, column, ctx) {
  const projectStatus = ctx.statuses.get(ticket.id) ?? null;
  return {
    id: ticket.id,
    title: ticket.title,
    column,
    state: agentStateOf(ticket.labels),
    labels: ticket.labels ?? [],
    assignees: ticket.assignees ?? [],
    epic: ctx.epicOf.get(ticket.id) ?? null,
    projectStatus,
    statusMatches: statusMatchesOf(ticket, column, projectStatus),
    environment: environmentOf(ticket.labels),
    overrides: overridesOf(ticket.labels),
    pr: prFor(ticket.id, ctx.prs),
    dependsOn: parseBlockedBy(ticket.body ?? ''),
    drops: dropsFor(ticket, ctx),
  };
}

const isEpic = (ticket) => (ticket.labels ?? []).includes(TYPE_LABELS.EPIC);

/** Each child Story id mapped to the open Epic that lists it; the first Epic wins. */
function epicIndex(epics) {
  const index = new Map();
  for (const epic of epics ?? []) {
    for (const child of epic.children) {
      if (!index.has(child))
        index.set(child, { id: epic.id, title: epic.title });
    }
  }
  return index;
}

/**
 * @param {{
 *   environments: import('./environments.js').Environment[],
 *   openTickets: object[],
 *   closedStories: object[],
 *   prs: object[],
 *   operator?: string|null,
 *   doneLimit?: number,
 *   closedTotal?: number|null,
 *   epics?: Array<{ id: number, title: string, children: number[] }>,
 *   statuses?: Map<number, string>,
 *   config?: object,
 * }} board `config` supplies the override model allowlist.
 * @returns {{ environments: object[], launchChoices: object,
 *   stories: object[], doneShown: number, doneTotal: number|null }}
 */
export function buildStatus({
  environments,
  openTickets,
  closedStories,
  prs,
  operator = null,
  doneLimit = DEFAULT_DONE_LIMIT,
  closedTotal = null,
  epics = [],
  statuses = new Map(),
  config,
}) {
  const loads = computeLoads(environments, openTickets);
  const ctx = {
    environments,
    loads,
    operator,
    prs: prs ?? [],
    openIds: new Set(openTickets.map((t) => t.id)),
    epicOf: epicIndex(epics),
    statuses,
  };
  const open = openTickets
    .filter((t) => !isEpic(t))
    .map((t) => [t, columnOf(t)])
    .filter(([, column]) => column !== null)
    .map(([t, column]) => storyRow(t, column, ctx));
  const done = [...closedStories]
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, doneLimit)
    .map((t) => storyRow(t, 'done', ctx));
  return {
    environments: environments.map(
      ({ command, routine, tokenEnv, ...shown }) => ({
        ...shown,
        load: loads[shown.name],
      }),
    ),
    launchChoices: launchChoices(config),
    stories: [...open, ...done],
    doneShown: done.length,
    doneTotal: closedTotal,
  };
}

const closedStory = (issue) => ({
  id: issue.number,
  title: issue.title,
  body: issue.body ?? '',
  labels: (issue.labels ?? []).map((l) => l.name ?? l),
  assignees: (issue.assignees ?? []).map((a) => a.login),
  state: 'closed',
  closedAt: issue.closed_at ?? null,
});

/** Sorted by update, not close, so it reads spare rows; a page holds at most 100. */
async function closedPage(gh, repoPath, doneLimit) {
  const perPage = Math.min(100, Math.max(50, doneLimit * 2));
  const raw = await gh.api({
    endpoint:
      `/repos/${repoPath}/issues?state=closed&labels=${encodeURIComponent(TYPE_LABELS.STORY)}` +
      `&sort=updated&direction=desc&per_page=${perPage}`,
  });
  return JSON.parse(raw.stdout || '[]')
    .filter((issue) => !issue.pull_request)
    .map(closedStory);
}

const totalCount = (raw) => {
  const total = JSON.parse(raw.stdout || '{}').total_count;
  return Number.isInteger(total) ? total : null;
};

/** Every closed Story's count from one search request, or `null` when it fails. */
function closedStoryTotal(gh, repoPath) {
  const query = encodeURIComponent(
    `repo:${repoPath} is:issue is:closed label:"${TYPE_LABELS.STORY}"`,
  );
  return gh
    .api({ endpoint: `/search/issues?q=${query}&per_page=1` })
    .then(totalCount)
    .catch(() => null);
}

/** Child ids an Epic's body lists as `- [ ] #<id>` checklist items. */
const checklistChildren = (body) =>
  [...String(body ?? '').matchAll(/-\s*\[[ xX]\]\s+#(\d+)/g)].map((m) =>
    Number(m[1]),
  );

/** An open Epic with its children: checklist items plus native sub-issues. */
async function epicWithChildren(provider, epic) {
  const native = await Promise.resolve(
    provider.getNativeSubIssues?.(epic.nodeId, epic.id),
  ).catch(() => null);
  const children = new Set([
    ...checklistChildren(epic.body),
    ...(native ?? []),
  ]);
  return { id: epic.id, title: epic.title, children: [...children] };
}

/** The open tickets and, for each open Epic among them, its children. */
async function openTicketsWithEpics(provider) {
  const openTickets = await provider.listTicketsByLabel({ state: 'open' });
  const epics = await Promise.all(
    openTickets.filter(isEpic).map((e) => epicWithChildren(provider, e)),
  );
  return { openTickets, epics };
}

/**
 * Live board data: every open issue (with each open Epic's children), the most recently updated closed
 * Stories (one page of up to 100, sorted by `closedAt` in
 * {@link buildStatus}), their total count, and the open pull requests with
 * their checks, plus each Story's Projects v2 Status.
 *
 * @param {{ provider: object, gh: object, config: object, doneLimit?: number }} deps
 * @returns {Promise<{ openTickets: object[], epics: object[],
 *   closedStories: object[], closedTotal: number|null, prs: object[],
 *   statuses: Map<number, string> }>}
 */
export async function fetchBoard({
  provider,
  gh,
  config,
  doneLimit = DEFAULT_DONE_LIMIT,
}) {
  const repoPath = `${config?.github?.owner ?? '{owner}'}/${config?.github?.repo ?? '{repo}'}`;
  const [open, closedStories, closedTotal, prs] = await Promise.all([
    openTicketsWithEpics(provider),
    closedPage(gh, repoPath, doneLimit),
    closedStoryTotal(gh, repoPath),
    gh.pr.list(
      ['--state', 'open', '--limit', '100'],
      ['number', 'url', 'headRefName', 'statusCheckRollup'],
    ),
  ]);
  const storyIds = [
    ...open.openTickets.filter((t) => !isEpic(t)),
    ...closedStories,
  ].map((t) => t.id);
  return {
    ...open,
    closedStories,
    closedTotal,
    prs: Array.isArray(prs) ? prs : [],
    statuses: await readProjectStatuses(provider, storyIds, config),
  };
}

const offlineNote = (env) =>
  env.online ? '' : ` offline (${env.offlineReason})`;

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
      `  ${env.name.padEnd(16)} ${env.target.padEnd(12)} ${env.load}/${env.capacity}${offlineNote(env)}`,
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
