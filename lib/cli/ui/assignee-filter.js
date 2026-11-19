// lib/cli/ui/assignee-filter.js
/**
 * The board's assignee filter: which people's Stories the columns show.
 * The selection is a list of GitHub logins plus `UNASSIGNED`; an empty list
 * shows everyone. It is saved per browser, apart from Settings, because its
 * choices come from the board rather than a fixed set. Pure apart from the
 * storage handed in, so it runs in the browser and under `node --test`.
 *
 * @module cli/ui/assignee-filter
 */

const FILTER_KEY = 'mandrel-board-assignees';

/** The selection value for Stories with no assignee. */
const UNASSIGNED = ':unassigned';

/**
 * The filter's choices: Unassigned first, then every login assigned to a
 * Story on the board, plus any still selected, sorted case-insensitively.
 *
 * @param {Array<{ assignees?: string[] }>} stories
 * @param {string[]} [selected]
 * @returns {Array<{ value: string, text: string, checked: boolean }>}
 */
export function assigneeOptions(stories, selected = []) {
  const logins = new Set(selected.filter((v) => v !== UNASSIGNED));
  for (const story of stories ?? []) {
    for (const login of story.assignees ?? []) logins.add(login);
  }
  const sorted = [...logins].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return [
    { value: UNASSIGNED, text: 'Unassigned' },
    ...sorted.map((login) => ({ value: login, text: login })),
  ].map((option) => ({ ...option, checked: selected.includes(option.value) }));
}

/**
 * Whether `story` shows under `selected`: everyone when nothing is
 * selected, else a Story assigned to a selected login, or an unassigned
 * Story when Unassigned is selected.
 *
 * @param {{ assignees?: string[] }} story
 * @param {string[]} selected
 */
export function matchesAssignees(story, selected) {
  if (selected.length === 0) return true;
  const assignees = story.assignees ?? [];
  if (assignees.length === 0) return selected.includes(UNASSIGNED);
  return assignees.some((login) => selected.includes(login));
}

/** The filter button's text: `Everyone`, the one choice, or a count. */
export function filterSummary(selected) {
  if (selected.length === 0) return 'Everyone';
  if (selected.length > 1) return `${selected.length} selected`;
  return selected[0] === UNASSIGNED ? 'Unassigned' : selected[0];
}

/** `selected` with `value` added or removed. */
export function toggleAssignee(selected, value, checked) {
  const rest = selected.filter((v) => v !== value);
  return checked ? [...rest, value] : rest;
}

/**
 * The saved selection; anything missing or malformed is everyone.
 *
 * @param {Storage|null} storage
 * @returns {string[]}
 */
export function loadAssigneeFilter(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(FILTER_KEY));
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Save `selected`; a blocked store keeps it for this page only. */
export function saveAssigneeFilter(storage, selected) {
  try {
    storage.setItem(FILTER_KEY, JSON.stringify(selected));
  } catch {
    // Nothing to recover: everyone shows on the next load.
  }
}
