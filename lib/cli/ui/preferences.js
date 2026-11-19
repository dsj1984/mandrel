// lib/cli/ui/preferences.js
/**
 * The board's per-browser preferences: one JSON object in browser storage,
 * every value one of a fixed set of choices, and the Done column header
 * they drive. Pure apart from the storage handed in, so it runs in the
 * browser and under `node --test`.
 *
 * @module cli/ui/preferences
 */

const SETTINGS_KEY = 'mandrel-board-settings';

/** Where the theme lived before Settings; read once, then removed. */
const LEGACY_THEME_KEY = 'mandrel-ui-theme';

const FIELDS = Object.freeze([
  {
    name: 'theme',
    label: 'Theme',
    testId: 'settings-theme',
    choices: ['auto', 'light', 'dark'],
    text: String,
  },
  {
    name: 'doneLimit',
    label: 'Done Stories shown',
    testId: 'settings-done-limit',
    choices: [10, 20, 50, 100],
    text: String,
  },
  {
    name: 'refreshSeconds',
    label: 'Refresh every',
    testId: 'settings-refresh',
    choices: [15, 30, 60],
    text: (seconds) => `${seconds} s`,
  },
]);

export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'auto',
  doneLimit: 20,
  refreshSeconds: 15,
});

function pick(field, value) {
  return (
    field.choices.find((choice) => String(choice) === String(value)) ??
    DEFAULT_PREFERENCES[field.name]
  );
}

function normalize(stored) {
  const source = stored !== null && typeof stored === 'object' ? stored : {};
  return Object.fromEntries(
    FIELDS.map((field) => [field.name, pick(field, source[field.name])]),
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readStored(storage) {
  try {
    return {
      stored: parseJson(storage.getItem(SETTINGS_KEY)),
      legacy: storage.getItem(LEGACY_THEME_KEY),
    };
  } catch {
    return { stored: null, legacy: null };
  }
}

/**
 * Write `prefs`; a blocked store keeps them for this page only.
 *
 * @param {Storage|null} storage
 * @param {object} prefs
 */
export function savePreferences(storage, prefs) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
    storage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Nothing to recover: the defaults return on the next load.
  }
}

/**
 * The saved preferences: anything missing, unparsable or not a choice is
 * its default, and a theme saved under the legacy key is carried over.
 *
 * @param {Storage|null} storage
 * @returns {{ theme: string, doneLimit: number, refreshSeconds: number }}
 */
export function loadPreferences(storage) {
  const { stored, legacy } = readStored(storage);
  if (legacy === null) return normalize(stored);
  const migrated = normalize({ theme: legacy, ...stored });
  savePreferences(storage, migrated);
  return migrated;
}

/** `prefs` with `name` set from a control's value; an unknown value is the default. */
export function withPreference(prefs, name, value) {
  const field = FIELDS.find((f) => f.name === name);
  return field ? { ...prefs, [name]: pick(field, value) } : prefs;
}

/** The Settings view's labelled choices, each with its current value. */
export function settingsFields(prefs) {
  return FIELDS.map((field) => ({
    name: field.name,
    label: field.label,
    testId: field.testId,
    value: String(prefs[field.name]),
    options: field.choices.map((choice) => ({
      value: String(choice),
      text: field.text(choice),
    })),
  }));
}
