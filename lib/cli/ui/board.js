/* node:coverage ignore file -- browser-only DOM glue; its logic is board-model.js */
// lib/cli/ui/board.js
/**
 * The `mandrel ui` page script: fetch, render and wire events. Every view
 * decision comes from `board-model.js`; this file only turns the model into
 * elements, built with `textContent` and `setAttribute` alone, and posts the
 * action a drop or the Move menu chose. It implements no dispatch rule.
 */

import {
  buildBoard,
  connectionSummary,
  dropZones,
  environmentCards,
  moveOptions,
  nextTheme,
  storyDetailView,
  zoneVerdict,
} from './board-model.js';

const POLL_MS = 15_000;
const THEME_KEY = 'mandrel-ui-theme';
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="mandrel-token"]').content;
const ui = {
  state: null,
  connections: null,
  dragging: null,
  pending: null,
  detailId: null,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

let toastTimer = null;
function toast(text, isError = false) {
  const box = $('toast');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 5000);
}

async function api(path, body) {
  const init = { headers: { 'X-Mandrel-Token': token } };
  if (body) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  return { status: res.status, json: await res.json() };
}

function storyById(id) {
  return ui.state?.stories.find((s) => s.id === id) ?? null;
}

/** Copy a command for the operator to run; it is never run here. */
async function copyCommand(command) {
  try {
    await navigator.clipboard.writeText(command);
    toast(`Copied ${command}`);
  } catch {
    toast(`Run ${command}`);
  }
}

async function perform(story, verdict) {
  if (verdict.kind === 'none') return;
  if (verdict.kind === 'refused') {
    toast(verdict.text, true);
    return;
  }
  if (verdict.kind === 'copy') {
    await copyCommand(verdict.text);
    return;
  }
  if (verdict.kind === 'confirm') {
    ui.pending = { story, verdict };
    $('confirm-text').textContent = `#${story.id}: ${verdict.text}.`;
    $('confirm-stop').showModal();
    return;
  }
  await post(story, verdict);
}

async function post(story, verdict) {
  try {
    const { status, json } = await api('/api/action', {
      action: verdict.action,
      storyId: story.id,
      environment: verdict.environment,
    });
    if (status === 200) toast(`#${story.id}: ${verdict.text}`);
    else toast(json.detail ?? json.reason ?? json.error ?? 'Refused', true);
  } catch {
    toast('The board server did not answer.', true);
  }
  await refresh();
}

/** A link that opens in a new tab; `href` is already a GitHub URL or null. */
function link(href, text, testId = null) {
  return el(
    'a',
    {
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-testid': testId,
    },
    text,
  );
}

function statusRow(card) {
  const { stage, steps, liveness, running, updated } = card.status;
  const stepper = el('ol', {
    class: 'stepper',
    'aria-label': 'Delivery stage',
  });
  for (const step of steps) {
    stepper.append(
      el('li', { class: `step ${step.state}`, title: step.name }, step.name),
    );
  }
  const badge = el(
    'span',
    {
      class: `liveness ${liveness.state} ${liveness.warning ? 'warning' : ''}`,
      'data-testid': `card-liveness-${card.id}`,
    },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    liveness.text,
  );
  const times = [stage, running, updated].filter(Boolean).join(' · ');
  return el(
    'div',
    { class: 'card-status', 'data-testid': `card-status-${card.id}` },
    stepper,
    el('div', { class: 'card-meta' }, badge, el('span', {}, times)),
  );
}

function prParts(pr) {
  if (!pr) return [];
  return [link(pr.url, `PR #${pr.number}`), el('span', {}, pr.checks)];
}

function cardMeta(card) {
  const meta = el('div', { class: 'card-meta' }, ...prParts(card.pr));
  if (card.unmet.length > 0) {
    const ids = card.unmet.map((id) => `#${id}`).join(', ');
    meta.append(el('span', { class: 'unmet' }, `waits on ${ids}`));
  }
  if (card.environment) meta.append(el('span', {}, card.environment));
  return meta;
}

/** One button per allowed move: the Move menu and the detail view share it. */
function moveButtons(story, role = null) {
  const options = moveOptions(story, dropZones(ui.state));
  if (options.length === 0) return [el('span', {}, 'No allowed moves')];
  return options.map((option) => {
    const item = el('button', { type: 'button', role }, option.text);
    item.addEventListener('click', () => perform(story, option));
    return item;
  });
}

function moveMenu(story, holder) {
  const menu = el('div', { class: 'move-menu', role: 'menu' });
  menu.append(...moveButtons(story, 'menuitem'));
  holder.append(menu);
}

function closePanel() {
  ui.detailId = null;
  $('side-panel').hidden = true;
  $('side-panel-view').replaceChildren();
  document.body.classList.remove('panel-open');
}

/** Open the Story detail view; the same Story again closes it. */
function toggleDetail(id) {
  if (ui.detailId === id) {
    closePanel();
    return;
  }
  ui.detailId = id;
  $('side-panel').hidden = false;
  document.body.classList.add('panel-open');
  $('side-panel-view').replaceChildren(el('p', {}, 'Loading…'));
  refreshDetail();
}

function definitionList(rows) {
  return el(
    'dl',
    {},
    ...rows.flatMap(([term, value]) => [
      el('dt', {}, term),
      el('dd', {}, String(value)),
    ]),
  );
}

function resumeBlock(command) {
  if (!command) return null;
  const copy = el(
    'button',
    { type: 'button', 'data-testid': 'story-detail-resume-copy' },
    'Copy',
  );
  copy.addEventListener('click', () => copyCommand(command));
  return el('div', { class: 'resume' }, el('code', {}, command), copy);
}

/** `build(items)` under a heading, or `empty` when there are none. */
function section(title, items, build, empty) {
  return [
    el('h3', {}, title),
    items.length > 0 ? build(items) : el('p', {}, empty),
  ];
}

const listOf = (lines) =>
  el('ol', { class: 'timeline' }, ...lines.map((line) => el('li', {}, line)));

function detailElement(detail) {
  const view = storyDetailView(detail);
  const story = storyById(detail.id);
  const issue = view.issueUrl
    ? link(view.issueUrl, 'GitHub issue', 'story-detail-issue-link')
    : null;
  return el(
    'section',
    { class: 'story-detail', 'data-testid': 'story-detail' },
    el('h2', {}, view.heading),
    el('p', { class: 'detail-links' }, issue, ...prParts(view.pr)),
    definitionList(view.facts),
    el('h3', {}, 'Actions'),
    el(
      'div',
      { class: 'detail-actions' },
      ...(story ? moveButtons(story) : []),
    ),
    ...section('Stage timeline', view.timeline, listOf, 'No stage published.'),
    ...section(
      'Dispatch record',
      view.record,
      definitionList,
      'No dispatch record.',
    ),
    resumeBlock(view.resumeCommand),
    el('h3', {}, 'Log'),
    el('pre', { class: 'log', 'data-testid': 'story-detail-log' }, view.log),
  );
}

async function refreshDetail() {
  const id = ui.detailId;
  if (id === null) return;
  try {
    const { status, json } = await api(`/api/story?id=${id}`);
    if (ui.detailId !== id) return;
    $('side-panel-view').replaceChildren(
      status === 200
        ? detailElement(json)
        : el('p', {}, `Story #${id} is not on the board.`),
    );
  } catch {
    toast('Could not read the Story detail.', true);
  }
}

/** Double-click, the context menu, Enter or Space open the detail view. */
function bindDetailTriggers(node, id) {
  node.addEventListener('dblclick', (event) => {
    if (!event.target.closest('button, a')) toggleDetail(id);
  });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    toggleDetail(id);
  });
  node.addEventListener('keydown', (event) => {
    if (event.target !== node) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleDetail(id);
  });
}

function cardElement(card) {
  const story = storyById(card.id);
  const node = el('article', {
    class: `card ${story.column === 'blocked' ? 'blocked' : ''} ${story.column === 'delivering' ? 'live' : ''}`,
    draggable: 'true',
    tabindex: '0',
    'aria-label': `#${card.id} ${card.title}`,
    'data-testid': `card-${card.id}`,
  });
  const details = el(
    'button',
    {
      type: 'button',
      'aria-label': `Details for #${card.id}`,
      'data-testid': `card-details-${card.id}`,
    },
    '⋯',
  );
  details.addEventListener('click', () => toggleDetail(card.id));
  const move = el(
    'button',
    {
      type: 'button',
      'data-testid': `card-move-${card.id}`,
      'aria-expanded': 'false',
    },
    'Move',
  );
  move.addEventListener('click', () => {
    const open = node.querySelector('.move-menu');
    if (open) open.remove();
    else moveMenu(story, node);
    move.setAttribute('aria-expanded', String(!open));
  });
  node.append(
    el('div', { class: 'card-id' }, `#${card.id}`),
    el('p', { class: 'card-title' }, card.title),
    ...(card.status ? [statusRow(card)] : []),
    cardMeta(card),
    el('div', { class: 'card-actions' }, move, details),
  );
  bindDetailTriggers(node, card.id);
  node.addEventListener('dragstart', (event) => {
    ui.dragging = story;
    event.dataTransfer.setData('text/plain', String(story.id));
    showHints(story);
  });
  node.addEventListener('dragend', clearHints);
  return node;
}

function laneElement(lane) {
  const meta = lane.target ? `${lane.target} · ${lane.header}` : lane.header;
  const node = el(
    'div',
    {
      class: `lane ${lane.online ? '' : 'offline'}`,
      'data-testid': `lane-${lane.name}`,
      'data-zone': lane.name,
    },
    el('h3', {}, lane.name, el('span', { class: 'zone-hint' })),
    el('div', { class: 'lane-meta' }, meta),
  );
  const cards = el('div', { class: 'cards' });
  cards.append(...lane.cards.map(cardElement));
  node.append(cards);
  bindZone(node);
  return node;
}

function renderBoard() {
  const board = buildBoard(ui.state, ui.connections);
  for (const column of board.columns) {
    const section = document.querySelector(
      `[data-testid="column-${column.id}"]`,
    );
    if (column.lanes) {
      section
        .querySelector('.lanes')
        .replaceChildren(...column.lanes.map(laneElement));
    } else {
      section
        .querySelector('.cards')
        .replaceChildren(...column.cards.map(cardElement));
    }
  }
  $('offline-count').textContent =
    board.offline > 0 ? `(${board.offline} offline)` : '';
}

function renderEnvironments() {
  const cards = environmentCards(ui.state, ui.connections).map((env) => {
    const stories = env.stories.map((id) => `#${id}`).join(', ') || 'none';
    const online = env.online ? 'online' : `offline (${env.reason})`;
    const rows = [
      ['Target', env.target],
      ['Load', env.load],
      ['State', online],
      ['Defined in', env.definedIn],
      ['Stories', stories],
    ].flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]);
    return el(
      'article',
      {
        class: `env-card ${env.online ? '' : 'offline'}`,
        'data-testid': `env-card-${env.name}`,
      },
      el('h3', { class: 'mono' }, env.name),
      el('dl', {}, ...rows),
    );
  });
  $('environments').replaceChildren(...cards);
}

function renderConnections() {
  const summary = connectionSummary(ui.connections);
  const button = $('connections-button');
  button.textContent = summary.ok ? 'Connected' : 'Connections need attention';
  button.classList.toggle('ok', summary.ok);
  button.classList.toggle('bad', !summary.ok);
  $('connection-lines').replaceChildren(
    ...summary.lines.map((line) => el('li', {}, line)),
  );
}

function render() {
  if (!ui.state) return;
  $('repository').textContent = ui.state.repository ?? '';
  renderBoard();
  renderEnvironments();
  renderConnections();
}

function zoneNodes() {
  return document.querySelectorAll('[data-zone]');
}

function showHints(story) {
  for (const zone of zoneNodes()) {
    const verdict = zoneVerdict(story, zone.dataset.zone);
    zone.querySelector('.zone-hint').textContent =
      verdict.kind === 'none' ? '' : verdict.text;
    zone.classList.toggle('zone-ok', ['action', 'copy'].includes(verdict.kind));
    zone.classList.toggle('zone-confirm', verdict.kind === 'confirm');
    zone.classList.toggle('zone-refused', verdict.kind === 'refused');
  }
}

function clearHints() {
  ui.dragging = null;
  $('zone-verdict').textContent = '';
  for (const zone of zoneNodes()) {
    zone.querySelector('.zone-hint').textContent = '';
    zone.classList.remove('zone-ok', 'zone-confirm', 'zone-refused');
  }
}

/** The innermost zone wins: a lane inside Delivering, not the column. */
function bindZone(node) {
  node.addEventListener('dragover', (event) => {
    if (!ui.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    $('zone-verdict').textContent = zoneVerdict(
      ui.dragging,
      node.dataset.zone,
    ).text;
  });
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const story = ui.dragging;
    clearHints();
    if (story) perform(story, zoneVerdict(story, node.dataset.zone));
  });
}

async function refresh() {
  try {
    const { status, json } = await api('/api/state');
    if (status !== 200) throw new Error(json.error);
    ui.state = json;
    render();
  } catch {
    toast('Could not read the board state.', true);
  }
  await refreshDetail();
}

async function refreshConnections() {
  try {
    ui.connections = (await api('/api/connections')).json;
  } catch {
    ui.connections = null;
  }
  render();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').textContent = `Theme: ${theme}`;
}

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'auto';
  } catch {
    return 'auto';
  }
}

function selectTab(name) {
  const onBoard = name === 'board';
  $('board').hidden = !onBoard;
  $('environments').hidden = onBoard;
  $('tab-board').setAttribute('aria-selected', String(onBoard));
  $('tab-environments').setAttribute('aria-selected', String(!onBoard));
}

function wire() {
  for (const column of document.querySelectorAll('.column[data-zone]'))
    bindZone(column);
  $('tab-board').addEventListener('click', () => selectTab('board'));
  $('tab-environments').addEventListener('click', () =>
    selectTab('environments'),
  );
  $('connections-button').addEventListener('click', () => {
    $('connections-dialog').showModal();
    refreshConnections();
  });
  $('connections-close').addEventListener('click', () =>
    $('connections-dialog').close(),
  );
  $('confirm-cancel').addEventListener('click', () => {
    ui.pending = null;
    $('confirm-stop').close();
  });
  $('confirm-ok').addEventListener('click', () => {
    const pending = ui.pending;
    ui.pending = null;
    $('confirm-stop').close();
    if (pending) post(pending.story, pending.verdict);
  });
  $('side-panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || ui.detailId === null) return;
    // An open dialog takes Esc for itself.
    if (!document.querySelector('dialog[open]')) closePanel();
  });
  $('theme-toggle').addEventListener('click', () => {
    const theme = nextTheme(document.documentElement.dataset.theme);
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A blocked store only loses the override on reload.
    }
  });
}

applyTheme(readTheme());
wire();
refresh();
refreshConnections();
setInterval(refresh, POLL_MS);
