// lib/cli/ui/board-filter.js
/**
 * The board's header filters: which Project Statuses, Epics and people's
 * Stories the columns show. Each filter's selection is a list of
 * values plus its "none" value (No status, No Epic, Unassigned); an empty
 * list shows every Story. Selections are saved per browser, apart from Settings, because
 * their choices come from the board rather than a fixed set. Pure apart
 * from the storage handed in, so it runs in the browser and under
 * `node --test`.
 *
 * @module cli/ui/board-filter
 */

/** Project Status options in board order; any other sorts after them. */
const STATUS_ORDER = ['Todo', 'In Progress', 'On Hold', 'Done'];

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function byStatus(a, b) {
  const rank = (v) =>
    STATUS_ORDER.includes(v) ? STATUS_ORDER.indexOf(v) : STATUS_ORDER.length;
  return rank(a) - rank(b) || byName(a, b);
}

const byNumber = (a, b) => Number(a) - Number(b);
const asIs = (value) => value;

const FILTERS = {
  assignee: {
    key: 'mandrel-board-assignees',
    all: 'Everyone',
    none: ':unassigned',
    noneText: 'Unassigned',
    valuesOf: (story) => story.assignees ?? [],
    order: byName,
    label: asIs,
  },
  status: {
    key: 'mandrel-board-statuses',
    all: 'Any status',
    none: ':none',
    noneText: 'No status',
    valuesOf: (story) => (story.projectStatus ? [story.projectStatus] : []),
    order: byStatus,
    label: asIs,
  },
  epic: {
    key: 'mandrel-board-epics',
    all: 'Any Epic',
    none: ':none',
    noneText: 'No Epic',
    valuesOf: (story) => (story.epic ? [String(story.epic.id)] : []),
    order: byNumber,
    label: (value, story) => `#${value} ${story?.epic.title ?? ''}`.trim(),
  },
};

/** Each value still selected, then each on the board, mapped to its option text. */
function optionTexts(filter, stories, selected) {
  const texts = new Map(
    selected.filter((v) => v !== filter.none).map((v) => [v, filter.label(v)]),
  );
  for (const story of stories ?? []) {
    for (const v of filter.valuesOf(story)) {
      texts.set(v, filter.label(v, story));
    }
  }
  return texts;
}

/**
 * A filter's choices: its "none" value first, then every value on the
 * board, plus any still selected, in the filter's order.
 *
 * @param {'assignee'|'status'|'epic'} name
 * @param {object[]} stories
 * @param {string[]} [selected]
 * @returns {Array<{ value: string, text: string, checked: boolean }>}
 */
export function filterOptions(name, stories, selected = []) {
  const filter = FILTERS[name];
  const texts = optionTexts(filter, stories, selected);
  return [
    { value: filter.none, text: filter.noneText },
    ...[...texts.keys()]
      .sort(filter.order)
      .map((v) => ({ value: v, text: texts.get(v) })),
  ].map((option) => ({ ...option, checked: selected.includes(option.value) }));
}

/**
 * Whether `story` shows under `selected`: every Story when nothing is
 * selected, else one carrying a selected value, or one carrying none when
 * the "none" value is selected.
 *
 * @param {'assignee'|'status'|'epic'} name
 * @param {object} story
 * @param {string[]} selected
 */
export function matchesFilter(name, story, selected) {
  if (selected.length === 0) return true;
  const values = FILTERS[name].valuesOf(story);
  if (values.length === 0) return selected.includes(FILTERS[name].none);
  return values.some((value) => selected.includes(value));
}

/** The filter button's text: the "all" text, the one choice, or a count. */
export function filterSummary(name, selected) {
  const filter = FILTERS[name];
  if (selected.length === 0) return filter.all;
  if (selected.length > 1) return `${selected.length} selected`;
  return selected[0] === filter.none
    ? filter.noneText
    : filter.label(selected[0]);
}

/** `selected` with `value` added or removed. */
export function toggleValue(selected, value, checked) {
  const rest = selected.filter((v) => v !== value);
  return checked ? [...rest, value] : rest;
}

/**
 * The saved selection; anything missing or malformed shows every Story.
 *
 * @param {Storage|null} storage
 * @param {'assignee'|'status'|'epic'} name
 * @returns {string[]}
 */
export function loadFilter(storage, name) {
  try {
    const parsed = JSON.parse(storage.getItem(FILTERS[name].key));
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Save `selected`; a blocked store keeps it for this page only. */
export function saveFilter(storage, name, selected) {
  try {
    storage.setItem(FILTERS[name].key, JSON.stringify(selected));
  } catch {
    // Nothing to recover: every Story shows on the next load.
  }
}
