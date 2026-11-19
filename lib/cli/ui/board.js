/* node:coverage ignore file -- browser-only DOM glue; its logic is board-model.js */
// lib/cli/ui/board.js
/**
 * The `mandrel ui` page script: fetch, render and wire events. Every view
 * decision comes from `board-model.js`; this file only turns the model into
 * elements, built with `textContent` and `setAttribute` alone, and posts the
 * action a drop or a card's action button chose. It implements no dispatch rule.
 */

import {
  filterOptions,
  filterSummary,
  loadFilter,
  matchesFilter,
  saveFilter,
  toggleValue,
} from './board-filter.js';
import {
  buildBoard,
  dropZones,
  environmentCards,
  launchOptionsView,
  matchesSearch,
  moveOptions,
  storyDetailView,
  zoneVerdict,
} from './board-model.js';
import {
  connectionsView,
  environmentRows,
  headerView,
  nextPanelView,
  storyOfView,
} from './panel-model.js';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  settingsFields,
  withPreference,
} from './preferences.js';

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="mandrel-token"]').content;
const ui = {
  state: null,
  connections: null,
  dragging: null,
  pending: null,
  view: null,
  detailId: null,
  offline: 0,
  prefs: { ...DEFAULT_PREFERENCES },
  timer: null,
  filters: { assignee: [], status: [], epic: [] },
  search: '',
  launchStory: null,
  filterKeys: {},
};

/** The header filters, in header order; each has `<name>-filter` elements. */
const FILTER_NAMES = ['status', 'epic', 'assignee'];

/** Browser storage, or `null` where reading it throws. */
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/** The header button that opens each named panel view. */
const PANEL_BUTTONS = {
  connections: 'panel-connections-button',
  settings: 'panel-settings-button',
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

/** A `type="button"` button that runs `onClick`. */
function button(attrs, text, onClick) {
  const node = el('button', { type: 'button', ...attrs }, text);
  node.addEventListener('click', onClick);
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

/** The stage stepper, or nothing before a stage is published. */
function stepperElement(steps) {
  if (!steps) return null;
  return el(
    'ol',
    { class: 'stepper', 'aria-label': 'Delivery stage' },
    ...steps.map((step) =>
      el('li', { class: `step ${step.state}`, title: step.name }, step.name),
    ),
  );
}

function statusRow(card) {
  const { stage, steps, outside, liveness, running, updated } = card.status;
  if (outside) {
    return el(
      'p',
      { class: 'card-outside', 'data-testid': `card-outside-${card.id}` },
      'running outside the board',
    );
  }
  const badge = liveness
    ? el(
        'span',
        {
          class: `liveness ${liveness.state} ${liveness.warning ? 'warning' : ''}`,
          'data-testid': `card-liveness-${card.id}`,
        },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        liveness.text,
      )
    : null;
  const times = [stage, running, updated].filter(Boolean).join(' · ');
  return el(
    'div',
    { class: 'card-status', 'data-testid': `card-status-${card.id}` },
    stepperElement(steps),
    el('div', { class: 'card-meta' }, badge, el('span', {}, times)),
  );
}

function prParts(pr) {
  if (!pr) return [];
  return [link(pr.url, `PR #${pr.number}`), el('span', {}, pr.checks)];
}

/** `{ text, url }` items as links (plain text without a URL), comma-separated. */
function linkList(items) {
  return items.flatMap((item, i) => [
    i > 0 ? ', ' : null,
    item.url ? link(item.url, item.text) : item.text,
  ]);
}

function statusChip(chip, testId = null) {
  if (!chip) return null;
  return el(
    'span',
    { class: `status-chip ${chip.tone}`, 'data-testid': testId },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    chip.text,
  );
}

function cardMeta(card) {
  const meta = el(
    'div',
    { class: 'card-meta' },
    statusChip(card.projectStatus, `card-status-chip-${card.id}`),
    ...prParts(card.pr),
  );
  if (card.unmet.length > 0) {
    meta.append(
      el('span', { class: 'unmet' }, 'waits on ', ...linkList(card.unmet)),
    );
  }
  if (card.environment) meta.append(el('span', {}, card.environment));
  return meta;
}

/** One truncated line: why a Ready card waits, or why a Story is blocked. */
function reasonLines(card) {
  const lines = [];
  if (card.waiting?.text) {
    lines.push(
      el(
        'p',
        {
          class: 'card-reason',
          title: card.waiting.text,
          'data-testid': `card-refusal-${card.id}`,
        },
        card.waiting.text,
      ),
    );
  }
  if (card.blocker) {
    lines.push(
      el(
        'p',
        {
          class: 'card-reason blocker',
          title: card.blocker.text,
          'data-testid': `card-blocker-${card.id}`,
        },
        card.blocker.text,
      ),
    );
  }
  return lines;
}

/** One button per move in `options`: the card menu and the detail view share it. */
function optionButtons(story, options, role = null) {
  return options.map((option) => {
    const item = el('button', { type: 'button', role }, option.text);
    item.addEventListener('click', () => perform(story, option));
    return item;
  });
}

/** Every allowed move, for the detail view. */
function moveButtons(story) {
  const options = moveOptions(story, dropZones(ui.state));
  if (options.length === 0) return [el('span', {}, 'No allowed moves')];
  return optionButtons(story, options);
}

/** The `▾` button that opens a menu of the card's other moves. */
function moreButton(card, story, holder, rest) {
  const more = button(
    {
      'aria-label': `More actions for #${card.id}`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'data-testid': `card-action-more-${card.id}`,
    },
    '▾',
    () => {
      const open = holder.querySelector('.move-menu');
      if (open) open.remove();
      else {
        holder.append(
          el(
            'div',
            { class: 'move-menu', role: 'menu' },
            ...optionButtons(story, rest, 'menuitem'),
          ),
        );
      }
      more.setAttribute('aria-expanded', String(!open));
    },
  );
  return more;
}

/** The card's first allowed move as a button, a `▾` menu for the rest, then `✎`. */
function cardActions(card, story, holder) {
  const [first, ...rest] = card.actions;
  const action = first
    ? button(
        { class: 'card-action', 'data-testid': `card-action-${card.id}` },
        first.text,
        () => perform(story, first),
      )
    : null;
  const settings = button(
    {
      'aria-label': `Model and effort for #${card.id}`,
      title: 'Model and effort',
      'data-testid': `card-settings-${card.id}`,
    },
    '✎',
    () => openLaunchOptions(story),
  );
  return el(
    'div',
    { class: 'card-actions' },
    action,
    rest.length > 0 ? moreButton(card, story, holder, rest) : null,
    settings,
  );
}

function setPanelView(view) {
  ui.view = view;
  ui.detailId = storyOfView(view);
  for (const [name, id] of Object.entries(PANEL_BUTTONS)) {
    $(id).setAttribute('aria-expanded', String(view === name));
  }
  $('side-panel').hidden = view === null;
  document.body.classList.toggle('panel-open', view !== null);
  if (view === null) $('side-panel-view').replaceChildren();
}

function closePanel() {
  setPanelView(null);
}

/** Open a view; asking for the open one again closes the panel. */
function togglePanel(view) {
  setPanelView(nextPanelView(ui.view, view));
  if (ui.detailId !== null) {
    $('side-panel-view').replaceChildren(el('p', {}, 'Loading…'));
    refreshDetail();
  } else if (ui.view === 'settings') {
    renderSettings();
  } else {
    renderPanel();
    if (ui.view === 'connections') refreshConnections();
  }
}

const toggleDetail = (id) => togglePanel(`story-${id}`);

/** A fact's value: text, links, label chips or one Status chip. */
function factValue(value) {
  if (value?.links) return linkList(value.links);
  if (value?.chips) {
    return value.chips.map((text) => el('span', { class: 'label-chip' }, text));
  }
  if (value?.chip) return [statusChip(value.chip)];
  return [String(value)];
}

/** `[term, value, testId?]` rows as a definition list. */
function definitionList(rows) {
  return el(
    'dl',
    {},
    ...rows.flatMap(([term, value, testId]) => [
      el('dt', {}, term),
      el('dd', { 'data-testid': testId }, ...factValue(value)),
    ]),
  );
}

function resumeBlock(command) {
  if (!command) return null;
  const copy = button(
    { 'data-testid': 'story-detail-resume-copy' },
    'Copy',
    () => copyCommand(command),
  );
  return el('div', { class: 'resume' }, el('code', {}, command), copy);
}

/** `build(items)` under a heading; `empty`, or nothing without it, when there are none. */
function section(title, items, build, empty = null) {
  if (items.length > 0) return [el('h3', {}, title), build(items)];
  return empty ? [el('h3', {}, title), el('p', {}, empty)] : [];
}

const listOf = (lines) =>
  el('ol', { class: 'timeline' }, ...lines.map((line) => el('li', {}, line)));

const logBlock = (log) =>
  log
    ? el('pre', { class: 'log', 'data-testid': 'story-detail-log' }, log)
    : null;

function detailElement(detail) {
  const view = storyDetailView(detail, Date.now(), ui.state?.repository);
  const story = storyById(detail.id);
  const issue = view.issueUrl
    ? link(view.issueUrl, 'GitHub issue', 'story-detail-issue-link')
    : null;
  return el(
    'section',
    { class: 'panel-view', 'data-testid': 'story-detail' },
    el('h2', {}, view.heading),
    el('p', { class: 'detail-links' }, issue, ...prParts(view.pr)),
    definitionList(view.facts),
    el('h3', {}, 'Actions'),
    el(
      'div',
      { class: 'detail-actions' },
      ...(story ? moveButtons(story) : []),
    ),
    ...section('Stage timeline', view.timeline, listOf),
    ...section('Dispatch record', view.record, definitionList),
    resumeBlock(view.resumeCommand),
    ...section('Log', view.log ? [view.log] : [], () => logBlock(view.log)),
  );
}

async function refreshDetail() {
  const id = ui.detailId;
  if (id === null) return;
  try {
    const { status, json } = await api(
      `/api/story?id=${id}&done=${ui.prefs.doneLimit}`,
    );
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

/** A click on the card body (not a control), Enter or Space open the detail view. */
function bindDetailTriggers(node, id) {
  node.addEventListener('click', (event) => {
    if (!event.target.closest('a, button, input, select, textarea')) {
      toggleDetail(id);
    }
  });
  node.addEventListener('keydown', (event) => {
    if (event.target !== node) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleDetail(id);
  });
}

/** The card's `Epic #<id>` line, linked when its issue URL is known, titled in full. */
function epicLine(card) {
  if (!card.epic) return [];
  const testId = `card-epic-${card.id}`;
  const text = card.epic.url
    ? link(card.epic.url, card.epic.text, testId)
    : card.epic.text;
  if (card.epic.url && card.epic.title)
    text.setAttribute('title', card.epic.title);
  const attrs = {
    class: 'card-epic',
    title: card.epic.url ? null : card.epic.title,
    'data-testid': card.epic.url ? null : testId,
  };
  return [el('p', attrs, text)];
}

function fillSelect(select, field) {
  select.replaceChildren(...field.options.map(optionElement));
  select.value = field.value;
}

/** The pencil dialog: a Story's model and effort overrides. */
function openLaunchOptions(story) {
  const view = launchOptionsView(story, ui.state);
  ui.launchStory = story.id;
  $('launch-options-title').textContent = view.heading;
  fillSelect($('launch-options-model'), view.model);
  fillSelect($('launch-options-effort'), view.effort);
  $('launch-options-effective').replaceChildren(
    ...view.effective.map((line) => el('p', {}, line)),
  );
  $('launch-options-dialog').showModal();
}

/** A select's value, `null` for "Use default". */
const chosen = (id) => $(id).value || null;

async function saveLaunchOptions() {
  const storyId = ui.launchStory;
  const body = {
    storyId,
    model: chosen('launch-options-model'),
    effort: chosen('launch-options-effort'),
  };
  $('launch-options-dialog').close();
  try {
    const { status, json } = await api('/api/launch-options', body);
    if (status === 200) toast(`#${storyId}: launch options saved`);
    else toast(json.reason ?? json.error ?? 'Refused', true);
  } catch {
    toast('The board server did not answer.', true);
  }
  await refresh();
}

function cardElement(card) {
  const story = storyById(card.id);
  const node = el('article', {
    class: `card ${story.column === 'blocked' ? 'blocked' : ''} ${story.column === 'delivering' ? 'live' : ''} ${card.waiting ? 'waiting' : ''}`,
    draggable: 'true',
    tabindex: '0',
    'aria-label': `#${card.id} ${card.title}`,
    'data-testid': `card-${card.id}`,
  });
  node.append(
    el(
      'div',
      { class: 'card-id' },
      card.url
        ? link(card.url, `#${card.id}`, `card-link-${card.id}`)
        : `#${card.id}`,
    ),
    el('p', { class: 'card-title' }, card.title),
    ...epicLine(card),
    ...(card.status ? [statusRow(card)] : []),
    cardMeta(card),
    ...reasonLines(card),
    cardActions(card, story, node),
  );
  bindDetailTriggers(node, card.id);
  node.addEventListener('dragstart', (event) => {
    ui.dragging = story;
    document.body.classList.add('dragging');
    event.dataTransfer.setData('text/plain', String(story.id));
    showHints(story);
  });
  node.addEventListener('dragend', clearHints);
  return node;
}

/** A lane's name and load; a headless lane (one environment) keeps only its drop hint. */
function laneHeader(lane) {
  if (!lane.title) return [el('span', { class: 'zone-hint' })];
  const meta = lane.target ? `${lane.target} · ${lane.header}` : lane.header;
  return [
    el('h3', {}, lane.title, el('span', { class: 'zone-hint' })),
    el('div', { class: 'lane-meta' }, meta),
  ];
}

function laneElement(lane) {
  const node = el(
    'div',
    {
      class: `lane ${lane.online ? '' : 'offline'} ${lane.title ? '' : 'headless'}`,
      'data-testid': `lane-${lane.name}`,
      'data-zone': lane.name,
    },
    ...laneHeader(lane),
  );
  const cards = el('div', { class: 'cards' });
  cards.append(...lane.cards.map(cardElement));
  node.append(cards);
  bindZone(node);
  return node;
}

function setFilter(name, selected) {
  ui.filters[name] = selected;
  saveFilter(storage, name, selected);
  render();
}

function filterOption(name, option) {
  const box = el('input', {
    type: 'checkbox',
    value: option.value,
    'data-testid': `${name}-option-${option.value}`,
  });
  box.checked = option.checked;
  box.addEventListener('change', () =>
    setFilter(name, toggleValue(ui.filters[name], option.value, box.checked)),
  );
  return el('label', {}, box, option.text);
}

/** A filter's menu, rebuilt only when its choices or selection change. */
function renderFilter(name) {
  const selected = ui.filters[name];
  const options = filterOptions(name, ui.state.stories, selected);
  $(`${name}-filter-summary`).textContent = filterSummary(name, selected);
  $(`${name}-filter`).classList.toggle('active', selected.length > 0);
  const key = JSON.stringify(options);
  if (key === ui.filterKeys[name]) return;
  ui.filterKeys[name] = key;
  const all = button(
    { 'data-testid': `${name}-filter-all` },
    filterSummary(name, []),
    () => setFilter(name, []),
  );
  $(`${name}-filter-menu`).replaceChildren(
    all,
    ...options.map((option) => filterOption(name, option)),
  );
}

const shownByFilters = (story) =>
  matchesSearch(story, ui.search) &&
  FILTER_NAMES.every((name) => matchesFilter(name, story, ui.filters[name]));

/** A column's count, its one environment's load, and its collapsed rail. */
function columnHeader(section, column) {
  $(`column-count-${column.id}`).textContent = column.countText;
  const load = section.querySelector('.column-load');
  if (load) load.textContent = column.header ?? '';
  section.classList.toggle('collapsed', column.count === 0);
}

function renderBoard() {
  const board = buildBoard(
    ui.state,
    ui.connections,
    Date.now(),
    shownByFilters,
  );
  for (const column of board.columns) {
    const section = document.querySelector(
      `[data-testid="column-${column.id}"]`,
    );
    columnHeader(section, column);
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
  ui.offline = board.offline;
}

/** One card per environment: target, load, state, where defined, open Stories. */
function environmentCardsElement(cards) {
  return el(
    'div',
    {},
    ...cards.map((env) =>
      el(
        'article',
        {
          class: `env-card ${env.online ? '' : 'offline'}`,
          'data-testid': `env-card-${env.name}`,
        },
        el('h4', { class: 'mono' }, env.name),
        definitionList(environmentRows(env)),
      ),
    ),
  );
}

function connectionsElement() {
  const view = connectionsView(ui.connections);
  const environments = environmentCards(ui.state, ui.connections);
  return el(
    'section',
    { class: 'panel-view', 'data-testid': 'connections-view' },
    el('h2', {}, 'Connections'),
    ...view.sections.flatMap((s) => [
      el('h3', {}, s.title),
      definitionList(s.rows),
    ]),
    ...section(
      'Environments',
      environments,
      environmentCardsElement,
      'None configured.',
    ),
    el('p', { class: 'note' }, view.note),
  );
}

const PANEL_VIEWS = {
  connections: connectionsElement,
};

const optionElement = (o) => el('option', { value: o.value }, o.text);

function settingSelect(field) {
  const select = el(
    'select',
    { id: field.testId, 'data-testid': field.testId },
    ...field.options.map(optionElement),
  );
  select.value = field.value;
  select.addEventListener('change', () =>
    setPreferences(withPreference(ui.prefs, field.name, select.value)),
  );
  return select;
}

function settingControl(field) {
  return el(
    'div',
    { class: 'setting' },
    el('label', { for: field.testId }, field.label),
    settingSelect(field),
  );
}

/** The Settings view; polls never rebuild it, so a control keeps focus. */
function renderSettings() {
  const reset = button(
    { 'data-testid': 'settings-reset' },
    'Reset to defaults',
    resetSettings,
  );
  $('side-panel-view').replaceChildren(
    el(
      'section',
      { class: 'panel-view', 'data-testid': 'settings-view' },
      el('h2', {}, 'Settings'),
      ...settingsFields(ui.prefs).map(settingControl),
      reset,
      el('p', { class: 'note' }, 'Saved in this browser only.'),
    ),
  );
}

function resetSettings() {
  setPreferences({ ...DEFAULT_PREFERENCES });
  renderSettings();
}

/** Re-render an open Connections view. */
function renderPanel() {
  const build = PANEL_VIEWS[ui.view];
  if (build) $('side-panel-view').replaceChildren(build());
}

function labelButton(id, label) {
  $(id).setAttribute('aria-label', label);
  $(id).setAttribute('title', label);
}

function renderHeader(offline) {
  const view = headerView(offline, ui.connections);
  const badge = $('panel-connections-offline-count');
  badge.textContent = view.badge;
  badge.hidden = view.badge === '';
  labelButton('panel-connections-button', view.connections);
  $('panel-connections-button').classList.toggle('ok', view.ok);
  $('panel-connections-button').classList.toggle('bad', !view.ok);
}

function render() {
  if (ui.state) {
    $('repository').textContent = ui.state.repository ?? '';
    for (const name of FILTER_NAMES) renderFilter(name);
    renderBoard();
  }
  renderHeader(ui.offline);
  renderPanel();
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
  document.body.classList.remove('dragging');
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

/** What the page says for each state-read failure code the server sends. */
const STATE_ERRORS = {
  'no-github-repo':
    'No GitHub repository is configured here. Start mandrel ui from the project root.',
  'config-invalid':
    'The project configuration could not be read. See the mandrel ui terminal.',
};

async function refresh() {
  try {
    const { status, json } = await api(`/api/state?done=${ui.prefs.doneLimit}`);
    if (status !== 200) throw new Error(json?.error);
    ui.state = json;
    render();
  } catch (err) {
    toast(
      STATE_ERRORS[err.message] ??
        'Could not read the board state. See the mandrel ui terminal for the cause.',
      true,
    );
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

/** The theme, and polling on the chosen cadence. */
function applyPreferences() {
  document.documentElement.dataset.theme = ui.prefs.theme;
  clearInterval(ui.timer);
  ui.timer = setInterval(refresh, ui.prefs.refreshSeconds * 1000);
}

/** Save and apply `prefs`; a new Done limit re-reads the board now. */
function setPreferences(prefs) {
  const reread = prefs.doneLimit !== ui.prefs.doneLimit;
  ui.prefs = prefs;
  savePreferences(storage, prefs);
  applyPreferences();
  if (reread) refresh();
}

/** Whether a text control has focus, so `/` types instead of jumping to search. */
const typing = () =>
  document.activeElement?.closest?.(
    'input, textarea, select, [contenteditable]',
  );

function wireSearch() {
  const search = $('board-search');
  search.addEventListener('input', () => {
    ui.search = search.value;
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    search.value = '';
    ui.search = '';
    render();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || typing() || document.querySelector('dialog[open]'))
      return;
    event.preventDefault();
    search.focus();
  });
}

function wire() {
  wireSearch();
  for (const column of document.querySelectorAll('.column[data-zone]'))
    bindZone(column);
  for (const [view, id] of Object.entries(PANEL_BUTTONS)) {
    $(id).addEventListener('click', () => togglePanel(view));
  }
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
  $('launch-options-cancel').addEventListener('click', () =>
    $('launch-options-dialog').close(),
  );
  $('launch-options-save').addEventListener('click', saveLaunchOptions);
  $('side-panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || ui.view === null) return;
    // An open dialog takes Esc for itself.
    if (!document.querySelector('dialog[open]')) closePanel();
  });
}

ui.prefs = loadPreferences(storage);
for (const name of FILTER_NAMES) ui.filters[name] = loadFilter(storage, name);
applyPreferences();
wire();
refresh();
refreshConnections();
