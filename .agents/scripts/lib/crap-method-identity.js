/** Order-independent identity for the methods of an escomplex report. */

/**
 * escomplex's label for an unnamed function: a file-wide positional counter,
 * so one insertion renumbers every later anonymous function.
 */
const ESCOMPLEX_ANON_LABEL_RE = /^<anon method-\d+>$/;

/**
 * A missing bound collapses to a zero-width span, never a drop, so the
 * method keeps a deterministic place in the scope tree.
 *
 * @param {{lineStart?: unknown, lineEnd?: unknown}} m
 * @returns {{lineStart: number, lineEnd: number}}
 */
function spanOf(m) {
  const lineStart = Number.isFinite(m?.lineStart) ? m.lineStart : 0;
  const lineEnd = Number.isFinite(m?.lineEnd) ? m.lineEnd : lineStart;
  return { lineStart, lineEnd: Math.max(lineStart, lineEnd) };
}

/** Anchor bytes that could not collide with segment syntax. */
const ANCHOR_UNSAFE_RE = /[^A-Za-z0-9_.$:-]/g;
const ANCHOR_MAX = 40;

/**
 * @param {unknown} anchor
 * @returns {string}
 */
function sanitizeAnchor(anchor) {
  if (typeof anchor !== 'string') return '';
  return anchor.replace(ANCHOR_UNSAFE_RE, '_').slice(0, ANCHOR_MAX);
}

/**
 * A label with every `#<ordinal>` stripped: what a row's identity is apart
 * from its tie-breaks, for re-pairing on a key miss.
 *
 * @param {string} label
 * @returns {string}
 */
export function methodStem(label) {
  return String(label).replace(/#\d+/g, '');
}

/**
 * `<anchor>(<params>)#<ordinal>`, counting the ordinal in `ordinals`.
 *
 * @param {object} m
 * @param {{anchor?: string|null}|undefined} site
 * @param {string} parentPath
 * @param {Map<string, number>} ordinals
 * @returns {string}
 */
function anonymousSegment(m, site, parentPath, ordinals) {
  const params = Array.isArray(m?.paramNames) ? m.paramNames : [];
  const head = `${sanitizeAnchor(site?.anchor)}(${params.join(',')})`;
  // NUL can never appear in a scope path; keep it an escape (a raw NUL
  // makes the file binary to git).
  const bucket = `${parentPath}\u0000${head}`;
  const ordinal = ordinals.get(bucket) ?? 0;
  ordinals.set(bucket, ordinal + 1);
  return `${head}#${ordinal}`;
}

/**
 * Close the spans that ended before `lineStart`; the innermost still open
 * is the line-span parent.
 *
 * @param {Array<{lineEnd: number, scopePath: string}>} openAncestors
 * @param {number} lineStart
 * @returns {string}
 */
function innermostOpenPath(openAncestors, lineStart) {
  while (openAncestors.length > 0 && openAncestors.at(-1).lineEnd < lineStart) {
    openAncestors.pop();
  }
  return openAncestors.at(-1)?.scopePath ?? '';
}

/**
 * The first holder of `scopePath` keeps it bare; each later one gets `#<n>`.
 *
 * @param {string} scopePath
 * @param {Map<string, number>} seen
 * @returns {string}
 */
function disambiguate(scopePath, seen) {
  const n = seen.get(scopePath) ?? 0;
  seen.set(scopePath, n + 1);
  return n === 0 ? scopePath : `${scopePath}#${n}`;
}

/**
 * A method's identity is its scope path: the enclosing method segments
 * joined by `/`, ending in its own segment, so a top-level named function
 * keeps its bare name. An anonymous one is wrapped as `<anon {scope path}>`,
 * e.g. `<anon build/arr.map(r)#0>`: its segment is a call-site anchor plus
 * parameter list plus an ordinal among siblings sharing parent, anchor and
 * parameters. A scope path seen earlier in the file gets `#<n>` (n from 1).
 * Never derived from the body — that would re-key a method on the very edit
 * the gate must catch.
 *
 * `sites[i]` (from the kernel's `methodSiteOf`) gives the exact enclosing
 * method and anchor; without one, nesting falls back to line spans (relying
 * on escomplex's pre-order emission) and there is no anchor.
 *
 * @param {Array<object>} methods `report.methods` from escomplex.
 * @param {Array<{parent: object|null, anchor: string|null}|undefined>} [sites]
 * @returns {Array<{method: string, anonymous: boolean}>} Index-aligned with
 *   `methods`.
 */
export function deriveMethodIdentities(methods, sites = []) {
  const identities = [];
  /** @type {Array<{lineEnd: number, scopePath: string}>} */
  const openAncestors = [];
  const pathOf = new Map();
  /** Sibling counts keyed by parent path + anchor + parameter list. */
  const ordinals = new Map();
  /** Collision counts per scope path, for the `#<n>` suffix. */
  const seen = new Map();

  for (const [i, m] of (methods ?? []).entries()) {
    const { lineStart, lineEnd } = spanOf(m);
    const spanParent = innermostOpenPath(openAncestors, lineStart);
    const site = sites?.[i];
    const parentPath = site ? (pathOf.get(site.parent) ?? '') : spanParent;
    const name = typeof m?.name === 'string' ? m.name : '';
    const anonymous = name === '' || ESCOMPLEX_ANON_LABEL_RE.test(name);
    const segment = anonymous
      ? anonymousSegment(m, site, parentPath, ordinals)
      : name;

    const scopePath = disambiguate(
      parentPath === '' ? segment : `${parentPath}/${segment}`,
      seen,
    );
    identities.push({
      method: anonymous ? `<anon ${scopePath}>` : scopePath,
      anonymous,
    });
    openAncestors.push({ lineEnd, scopePath });
    if (m !== null && typeof m === 'object') pathOf.set(m, scopePath);
  }

  return identities;
}
