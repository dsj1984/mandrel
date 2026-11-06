/** Order-independent identity for the methods of an escomplex report. */

/**
 * escomplex's label for an unnamed function: a file-wide positional counter,
 * so one insertion renumbers every later anonymous function.
 */
const ESCOMPLEX_ANON_LABEL_RE = /^<anon method-\d+>$/;

/**
 * True for a derived anonymous identity (ours or escomplex's).
 *
 * @param {unknown} method
 * @returns {boolean}
 */
export function isAnonymousMethodLabel(method) {
  return typeof method === 'string' && method.startsWith('<anon ');
}

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
 * A label with every `#<ordinal>` stripped: what an anonymous row's
 * identity is apart from its tie-break, for re-pairing on a key miss.
 *
 * @param {string} label
 * @returns {string}
 */
export function anonymousStem(label) {
  return String(label).replace(/#\d+/g, '');
}

/**
 * Named methods keep their name. An anonymous one becomes `<anon {scope
 * path}>`, e.g. `<anon build/arr.map(r)#0>`: each link is a name, or a
 * call-site anchor plus parameter list plus an ordinal among siblings
 * sharing parent, anchor and parameters. Never derived from the body — that
 * would re-key a method on the very edit the gate must catch.
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

  for (const [i, m] of (methods ?? []).entries()) {
    const { lineStart, lineEnd } = spanOf(m);
    while (
      openAncestors.length > 0 &&
      openAncestors[openAncestors.length - 1].lineEnd < lineStart
    ) {
      openAncestors.pop();
    }
    const site = sites?.[i];
    let parentPath;
    if (site) {
      parentPath = pathOf.get(site.parent) ?? '';
    } else {
      parentPath =
        openAncestors.length > 0
          ? openAncestors[openAncestors.length - 1].scopePath
          : '';
    }

    const name = typeof m?.name === 'string' ? m.name : '';
    let segment;
    let anonymous;
    if (name === '' || ESCOMPLEX_ANON_LABEL_RE.test(name)) {
      const params = Array.isArray(m?.paramNames) ? m.paramNames : [];
      const head = `${sanitizeAnchor(site?.anchor)}(${params.join(',')})`;
      // NUL can never appear in a scope path; keep it an escape (a raw NUL
      // makes the file binary to git).
      const bucket = `${parentPath}\u0000${head}`;
      const ordinal = ordinals.get(bucket) ?? 0;
      ordinals.set(bucket, ordinal + 1);
      segment = `${head}#${ordinal}`;
      anonymous = true;
    } else {
      segment = name;
      anonymous = false;
    }

    const scopePath = parentPath === '' ? segment : `${parentPath}/${segment}`;
    identities.push({
      method: anonymous ? `<anon ${scopePath}>` : name,
      anonymous,
    });
    openAncestors.push({ lineEnd, scopePath });
    if (m !== null && typeof m === 'object') pathOf.set(m, scopePath);
  }

  return identities;
}
