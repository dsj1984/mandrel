/**
 * pinned-override-resolve.js — resolve a documented override, and score its note.
 *
 * The reading half of `pinned-override-notes.js` next door: how an
 * `overrides` entry resolves to the range it actually imposes, and which
 * findings that range earns against the note describing it. The audit loop
 * stays there; everything a single note is judged by lives here.
 *
 * Pure: no filesystem, no npm, no network. The caller supplies the parsed
 * package document.
 */

/**
 * npm's own reference syntax inside an `overrides` block: `"js-yaml": "$js-yaml"`
 * means "whatever `dependencies.js-yaml` says". It is the sanctioned way to
 * express the lockstep coupling these notes describe, so reading it as a
 * literal range — which is what a bare string compare does — flagged the fix as
 * the defect: `"$js-yaml" !== "^4.3.2"` produced a `lockstep` finding against a
 * pair that npm guarantees can never split, and a `stale-note` against a note
 * quoting the range actually in force.
 */
const OVERRIDE_REFERENCE = /^\$(.*)$/;

/**
 * A semver **range**, not only a caret/tilde one. The old pattern required a
 * `^` or `~` prefix, so a note describing an exact pin (`"1.2.3"`) quoted a
 * version the matcher could not see: `quoted` came back empty, the staleness
 * check short-circuits on an empty list, and the note was silently exempt from
 * the guarantee it exists to provide.
 */
const SEMVER_RANGE = /(?:[\^~]|>=?|<=?|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

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
  return [...text.matchAll(SEMVER_RANGE)].map((m) => m[0]);
}

/**
 * Look a dotted note key up in the `overrides` tree.
 *
 * An `overrides` value may be a nested object — `{"foo": {"bar": "1.2.3"}}`
 * scopes the `bar` override to `foo`'s subtree — so `overrides.foo.bar` names a
 * real pin two levels down. The exact key is tried first at every level,
 * because package names legitimately contain dots (`lodash.merge`), and only
 * then is the key split.
 *
 * @param {unknown} node
 * @param {string} dottedName
 * @returns {{ found: boolean, value?: unknown }}
 */
function lookupOverride(node, dottedName) {
  if (!node || typeof node !== 'object') return { found: false };
  if (Object.hasOwn(node, dottedName)) {
    return { found: true, value: node[dottedName] };
  }
  const parts = dottedName.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const child = node[parts.slice(0, i).join('.')];
    const hit = lookupOverride(child, parts.slice(i).join('.'));
    if (hit.found) return hit;
  }
  return { found: false };
}

/**
 * Resolve the range a documented override actually imposes.
 *
 * @param {object} params
 * @returns {{ kind: 'missing'|'pinned'|'reference'|'unsupported', range?: string,
 *   raw?: unknown, referenced?: string, detail?: string }}
 */
export function resolvePin({ overrides, dependencies, name }) {
  const hit = lookupOverride(overrides, name);
  if (!hit.found) return { kind: 'missing' };
  if (typeof hit.value !== 'string') {
    return {
      kind: 'unsupported',
      raw: hit.value,
      detail:
        'resolves to a nested override object rather than a range. Key the note at the leaf ' +
        '(e.g. "overrides.<parent>.<name>") so the range it describes is the one checked.',
    };
  }
  const reference = OVERRIDE_REFERENCE.exec(hit.value);
  return reference
    ? resolveReference({
        raw: hit.value,
        target: reference[1] || name,
        dependencies,
      })
    : { kind: 'pinned', range: hit.value };
}

/**
 * Resolve npm's `"$name"` reference to the direct range it points at.
 *
 * @param {{ raw: string, target: string, dependencies: object }} params
 * @returns {{ kind: 'reference'|'unsupported', range?: string, raw?: string,
 *   referenced: string, detail?: string }}
 */
function resolveReference({ raw, target, dependencies }) {
  const direct = dependencies[target];
  if (typeof direct !== 'string') {
    return {
      kind: 'unsupported',
      raw,
      referenced: target,
      detail: `references "${raw}", but dependencies.${target} does not exist, so npm has nothing to resolve the override to.`,
    };
  }
  return { kind: 'reference', range: direct, referenced: target };
}

/**
 * Score one documented override against its note. Split out of the loop above
 * so each finding's rationale sits next to the condition that raises it.
 *
 * @param {{ key: string, name: string, text: unknown, resolved: object,
 *   direct: string|undefined }} params
 * @returns {Array<{ kind: string, name: string, detail: string }>}
 */
export function scoreNote({ key, name, text, resolved, direct }) {
  const refusal = refuseNote({ key, name, resolved });
  if (refusal) return [refusal];
  return [
    ...scoreLockstep({ name, resolved, direct }),
    ...scoreStaleness({ key, name, text, range: resolved.range }),
  ];
}

/**
 * The two ways a note names nothing checkable: the pin is gone, or the key
 * resolves to something that is not a range. They are deliberately different
 * findings — telling an author to "delete the note or restore the pin" when the
 * pin is right there, one level down, is wrong advice.
 *
 * @param {{ key: string, name: string, resolved: object }} params
 * @returns {{ kind: string, name: string, detail: string }|null}
 */
function refuseNote({ key, name, resolved }) {
  if (resolved.kind === 'missing') {
    return {
      kind: 'orphan-note',
      name,
      detail: `"//"["${key}"] documents an override that no longer exists in the overrides block. Delete the note or restore the pin — a safety note for a pin nobody has is read as though the pin were still there.`,
    };
  }
  if (resolved.kind === 'unsupported') {
    return {
      kind: 'unsupported-shape',
      name,
      detail: `"//"["${key}"] ${resolved.detail}`,
    };
  }
  return null;
}

/**
 * Does the override range still agree with the direct one? A `$name` override
 * IS `dependencies[name]`, so npm cannot split the pair the note is warning
 * about and there is nothing to compare.
 *
 * @param {{ name: string, resolved: object, direct: string|undefined }} params
 * @returns {Array<object>}
 */
function scoreLockstep({ name, resolved, direct }) {
  const split =
    resolved.kind === 'pinned' &&
    typeof direct === 'string' &&
    direct !== resolved.range;
  if (!split) return [];
  return [
    {
      kind: 'lockstep',
      name,
      detail: `overrides.${name} is "${resolved.range}" but dependencies.${name} is "${direct}". The "//" note declares these move in lockstep; a split gives the direct and transitive resolutions different floors. npm's own "$${name}" reference is the way to make the split impossible.`,
    },
  ];
}

/**
 * Does the note still state the range in force? A note quoting no range at all
 * is not scored: prose that names no version cannot go stale.
 *
 * @param {{ key: string, name: string, text: unknown, range: string }} params
 * @returns {Array<object>}
 */
function scoreStaleness({ key, name, text, range }) {
  const quoted = quotedRanges(text);
  if (quoted.length === 0 || quoted.includes(range)) return [];
  return [
    {
      kind: 'stale-note',
      name,
      detail: `"//"["${key}"] quotes ${quoted.map((q) => `"${q}"`).join(', ')} but the range in force is "${range}". The note is what tells the next author whether a bump is safe, so it must state the version it is describing.`,
    },
  ];
}
