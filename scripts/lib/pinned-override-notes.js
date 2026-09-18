/**
 * pinned-override-notes.js — keep a load-bearing dependency note honest.
 *
 * `package.json` carries a `"//"` block of prose notes keyed by dotted config
 * path. Two of them are safety notes about a pinned `overrides` entry: they
 * record WHY the pin exists, which advisories removing it reintroduces, and
 * that the `overrides` range and the direct `dependencies` range MUST move in
 * lockstep because npm has no way to reference one from the other.
 *
 * A note like that is consulted precisely when someone is deciding whether a
 * bump is safe — so a stale version inside it hands out wrong premises about
 * a coupling the note itself calls a trap. Nothing enforced either claim, and
 * both had drifted: the note described `^4.2.0` while the pin had moved twice.
 *
 * This module derives the checks from the `"//"` keys themselves rather than
 * naming any package, so a second pinned override gets the same guarantee by
 * writing its note.
 */

/** A `"//"` key that documents a pinned override, e.g. `overrides.js-yaml`. */
const OVERRIDE_NOTE_KEY = /^overrides\.(.+)$/;

import { resolvePin, scoreNote } from './pinned-override-resolve.js';

/**
 * Audit one package document's pinned-override notes.
 *
 * Findings per documented override, each naming the drift rather than just
 * asserting a mismatch:
 *   - `lockstep` — `overrides.<name>` and `dependencies.<name>` disagree. The
 *     companion note declares they must not; a split silently gives the
 *     direct and transitive resolutions different floors.
 *   - `stale-note` — the note quotes at least one range but not the one in
 *     force, so its stated version is behind the pin it describes. A note
 *     quoting no range at all is not scored: prose that names no version
 *     cannot go stale.
 *   - `unsupported-shape` — the note's key resolves to something that is not a
 *     range (a nested override object, or a `$name` reference to a dependency
 *     that does not exist). Distinct from `orphan-note`: the pin is *there*,
 *     the note just does not name it, and telling an author to "delete the note
 *     or restore the pin" would be wrong advice.
 *
 * @param {{ '//'?: Record<string,string>, overrides?: Record<string,string>, dependencies?: Record<string,string> }} pkg
 * @returns {{ findings: Array<{ kind: string, name: string, detail: string }>, checked: string[] }}
 */
export function auditPinnedOverrideNotes(pkg) {
  const overrides = pkg?.overrides ?? {};
  const dependencies = pkg?.dependencies ?? {};
  const findings = [];
  const checked = [];

  for (const { key, name, text } of documentedOverrides(pkg)) {
    const resolved = resolvePin({ overrides, dependencies, name });
    if (isCheckable(resolved)) checked.push(name);
    findings.push(
      ...scoreNote({ key, name, text, resolved, direct: dependencies[name] }),
    );
  }

  return { findings, checked };
}

/**
 * The `"//"` entries that document an override, as `{ key, name, text }`.
 * Every other note in the block — a peer-dependency rationale, say — is not
 * this gate's business and is skipped rather than scored.
 *
 * @param {object} pkg
 * @returns {Array<{ key: string, name: string, text: unknown }>}
 */
function documentedOverrides(pkg) {
  return Object.entries(pkg?.['//'] ?? {})
    .map(([key, text]) => ({ key, text, match: OVERRIDE_NOTE_KEY.exec(key) }))
    .filter((entry) => entry.match !== null)
    .map(({ key, text, match }) => ({ key, text, name: match[1] }));
}

/**
 * Was the note's override resolved to a range at all? Only then does the name
 * belong in `checked` — the list is what tells a caller which pins this gate
 * actually stands behind.
 *
 * @param {{ kind: string }} resolved
 * @returns {boolean}
 */
function isCheckable(resolved) {
  return resolved.kind !== 'missing' && resolved.kind !== 'unsupported';
}
