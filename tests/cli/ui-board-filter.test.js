// tests/cli/ui-board-filter.test.js — the board's People, Status and Epic
// filters: choices from the board, the match rule, the summary and saved
// selection.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterOptions,
  filterSummary,
  loadFilter,
  matchesFilter,
  saveFilter,
  toggleValue,
} from '../../lib/cli/ui/board-filter.js';

const assigneeOptions = (stories, selected) =>
  filterOptions('assignee', stories, selected);
const matchesAssignees = (story, selected) =>
  matchesFilter('assignee', story, selected);
const loadAssigneeFilter = (storage) => loadFilter(storage, 'assignee');
const saveAssigneeFilter = (storage, selected) =>
  saveFilter(storage, 'assignee', selected);

const s = (...assignees) => ({ assignees });

/** The Unassigned choice's value, as the filter offers it. */
const UNASSIGNED = assigneeOptions([])[0].value;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  };
}

describe('assigneeOptions', () => {
  it('offers Unassigned first, then every assignee once, sorted case-insensitively', () => {
    const options = assigneeOptions(
      [s('zed', 'Ana'), s(), s('bo', 'zed')],
      ['bo'],
    );
    assert.deepEqual(options, [
      { value: UNASSIGNED, text: 'Unassigned', checked: false },
      { value: 'Ana', text: 'Ana', checked: false },
      { value: 'bo', text: 'bo', checked: true },
      { value: 'zed', text: 'zed', checked: false },
    ]);
  });

  it('keeps a selected login no Story carries any more', () => {
    const values = assigneeOptions([], ['gone']).map((o) => o.value);
    assert.deepEqual(values, [UNASSIGNED, 'gone']);
  });
});

describe('matchesAssignees', () => {
  it('shows everyone when nothing is selected', () => {
    assert.equal(matchesAssignees(s(), []), true);
    assert.equal(matchesAssignees(s('ana'), []), true);
  });

  it('shows a Story assigned to any selected login', () => {
    assert.equal(matchesAssignees(s('ana', 'bo'), ['bo']), true);
    assert.equal(matchesAssignees(s('ana'), ['bo']), false);
  });

  it('shows unassigned Stories only when Unassigned is selected', () => {
    assert.equal(matchesAssignees(s(), ['ana']), false);
    assert.equal(matchesAssignees({}, [UNASSIGNED]), true);
    assert.equal(matchesAssignees(s('ana'), [UNASSIGNED]), false);
  });
});

describe('summary and toggling', () => {
  it('summarises the selection', () => {
    assert.equal(filterSummary('assignee', []), 'Everyone');
    assert.equal(filterSummary('assignee', ['ana']), 'ana');
    assert.equal(filterSummary('assignee', [UNASSIGNED]), 'Unassigned');
    assert.equal(filterSummary('assignee', ['ana', UNASSIGNED]), '2 selected');
  });

  it('adds and removes one value', () => {
    assert.deepEqual(toggleValue(['ana'], 'bo', true), ['ana', 'bo']);
    assert.deepEqual(toggleValue(['ana', 'bo'], 'ana', false), ['bo']);
    assert.deepEqual(toggleValue(['ana'], 'ana', true), ['ana']);
  });
});

describe('saved selection', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    saveAssigneeFilter(storage, ['ana', UNASSIGNED]);
    assert.deepEqual(loadAssigneeFilter(storage), ['ana', UNASSIGNED]);
  });

  it('reads anything missing, malformed or blocked as everyone', () => {
    assert.deepEqual(loadAssigneeFilter(memoryStorage()), []);
    const bad = memoryStorage({ 'mandrel-board-assignees': '{nope' });
    assert.deepEqual(loadAssigneeFilter(bad), []);
    const obj = memoryStorage({ 'mandrel-board-assignees': '{"a":1}' });
    assert.deepEqual(loadAssigneeFilter(obj), []);
    const mixed = memoryStorage({ 'mandrel-board-assignees': '["ana",3]' });
    assert.deepEqual(loadAssigneeFilter(mixed), ['ana']);
    assert.deepEqual(loadAssigneeFilter(null), []);
  });

  it('keeps going when storage refuses a write', () => {
    const blocked = {
      setItem() {
        throw new Error('quota');
      },
    };
    assert.doesNotThrow(() => saveAssigneeFilter(blocked, ['ana']));
  });
});

describe('the Status filter', () => {
  const st = (projectStatus) => ({ projectStatus });
  const NONE = filterOptions('status', [])[0].value;

  it('offers No status first, then the statuses in board order', () => {
    const options = filterOptions(
      'status',
      [st('Done'), st('Triage'), st(null), st('On Hold'), st('Todo')],
      ['Done'],
    );
    assert.deepEqual(
      options.map((o) => [o.text, o.checked]),
      [
        ['No status', false],
        ['Todo', false],
        ['On Hold', false],
        ['Done', true],
        ['Triage', false],
      ],
    );
  });

  it('matches a selected Status, and No status only Stories without one', () => {
    assert.equal(matchesFilter('status', st('On Hold'), ['On Hold']), true);
    assert.equal(matchesFilter('status', st('Todo'), ['On Hold']), false);
    assert.equal(matchesFilter('status', st(null), [NONE]), true);
    assert.equal(matchesFilter('status', st('Todo'), [NONE]), false);
  });

  it('summarises and saves apart from the People filter', () => {
    assert.equal(filterSummary('status', []), 'Any status');
    assert.equal(filterSummary('status', [NONE]), 'No status');
    const storage = memoryStorage();
    saveFilter(storage, 'status', ['Todo']);
    assert.deepEqual(loadFilter(storage, 'status'), ['Todo']);
    assert.deepEqual(loadFilter(storage, 'assignee'), []);
    assert.deepEqual([...storage.data.keys()], ['mandrel-board-statuses']);
  });
});

describe('AC-8: the Epic filter', () => {
  const e = (id, title) => ({ epic: { id, title } });
  const stories = [e(12, 'Board'), {}, e(3, 'Dispatch'), e(12, 'Board')];

  it('offers No Epic first, then each Epic as #<id> <title> in id order', () => {
    assert.deepEqual(
      filterOptions('epic', stories, ['99']).map((o) => [o.value, o.text]),
      [
        [':none', 'No Epic'],
        ['3', '#3 Dispatch'],
        ['12', '#12 Board'],
        ['99', '#99'],
      ],
    );
  });

  it('matches a selected Epic, or No Epic, and combines with the other filters', () => {
    assert.equal(matchesFilter('epic', e(12, 'Board'), ['12']), true);
    assert.equal(matchesFilter('epic', e(3, 'Dispatch'), ['12']), false);
    assert.equal(matchesFilter('epic', {}, [':none']), true);
    const story = { ...e(12, 'Board'), projectStatus: 'Todo', assignees: [] };
    const shown = (selections) =>
      Object.entries(selections).every(([name, selected]) =>
        matchesFilter(name, story, selected),
      );
    assert.equal(shown({ epic: ['12'], status: ['Todo'] }), true);
    assert.equal(shown({ epic: ['12'], status: ['On Hold'] }), false);
  });

  it('summarises with the #id and saves under its own key', () => {
    assert.equal(filterSummary('epic', []), 'Any Epic');
    assert.equal(filterSummary('epic', ['12']), '#12');
    assert.equal(filterSummary('epic', [':none']), 'No Epic');
    const storage = memoryStorage();
    saveFilter(storage, 'epic', ['12']);
    assert.deepEqual(loadFilter(storage, 'epic'), ['12']);
    assert.deepEqual(loadFilter(storage, 'status'), []);
  });
});
