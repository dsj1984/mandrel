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

/**
 * Extract every semver range that appears literally in a note's prose.
 *
 * Deliberately permissive about the surrounding words — a note is prose, and
 * pinning its phrasing would make it unwritable. What matters is only that
 * the range it quotes is the range in force.
 *
 * Not exported: it is an implementation detail of the audit below, and its
 * behaviour is observable through that — a note quoting only bare versions
 * yields no `stale-note`, a note quoting a mismatched range yields one.
 *
 * @param {string} text
 * @returns {string[]}
 */
function quotedRanges(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(/[\^~]\d+\.\d+\.\d+/g)].map((m) => m[0]);
}

/**
 * Audit one package document's pinned-override notes.
 *
 * Two findings per documented override, each naming the drift rather than
 * just asserting a mismatch:
 *   - `lockstep` — `overrides.<name>` and `dependencies.<name>` disagree. The
 *     companion note declares they must not; a split silently gives the
 *     direct and transitive resolutions different floors.
 *   - `stale-note` — the note quotes at least one range but not the one in
 *     force, so its stated version is behind the pin it describes. A note
 *     quoting no range at all is not scored: prose that names no version
 *     cannot go stale.
 *
 * @param {{ '//'?: Record<string,string>, overrides?: Record<string,string>, dependencies?: Record<string,string> }} pkg
 * @returns {{ findings: Array<{ kind: string, name: string, detail: string }>, checked: string[] }}
 */
export function auditPinnedOverrideNotes(pkg) {
  const notes = pkg?.['//'] ?? {};
  const overrides = pkg?.overrides ?? {};
  const dependencies = pkg?.dependencies ?? {};
  const findings = [];
  const checked = [];

  for (const [key, text] of Object.entries(notes)) {
    const match = OVERRIDE_NOTE_KEY.exec(key);
    if (!match) continue;
    const name = match[1];
    const pinned = overrides[name];
    if (typeof pinned !== 'string') {
      findings.push({
        kind: 'orphan-note',
        name,
        detail: `"//"["${key}"] documents an override that no longer exists in the overrides block. Delete the note or restore the pin — a safety note for a pin nobody has is read as though the pin were still there.`,
      });
      continue;
    }
    checked.push(name);

    const direct = dependencies[name];
    if (typeof direct === 'string' && direct !== pinned) {
      findings.push({
        kind: 'lockstep',
        name,
        detail: `overrides.${name} is "${pinned}" but dependencies.${name} is "${direct}". The "//" note declares these move in lockstep; a split gives the direct and transitive resolutions different floors.`,
      });
    }

    const quoted = quotedRanges(text);
    if (quoted.length > 0 && !quoted.includes(pinned)) {
      findings.push({
        kind: 'stale-note',
        name,
        detail: `"//"["${key}"] quotes ${quoted.map((q) => `"${q}"`).join(', ')} but the pin in force is "${pinned}". The note is what tells the next author whether a bump is safe, so it must state the version it is describing.`,
      });
    }
  }

  return { findings, checked };
}
