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

/**
 * Named methods keep their name. An anonymous one becomes `<anon {scope
 * path}>`, e.g. `<anon build/(files,opts)#0/(r)#0>`: each enclosing link is a
 * name, or a parameter list plus an ordinal among siblings with the same
 * parent and parameter list. Never derived from the body — that would re-key
 * a method on the very edit the gate must catch. Relies on escomplex's
 * pre-order emission (ancestors first) for a single-pass ancestor stack.
 *
 * @param {Array<object>} methods `report.methods` from escomplex.
 * @returns {Array<{method: string, anonymous: boolean}>} Index-aligned with
 *   `methods`.
 */
export function deriveMethodIdentities(methods) {
  const identities = [];
  /** @type {Array<{lineEnd: number, scopePath: string}>} */
  const openAncestors = [];
  /** Sibling counts keyed by `parent scope path` + `parameter list`. */
  const ordinals = new Map();

  for (const m of methods ?? []) {
    const { lineStart, lineEnd } = spanOf(m);
    while (
      openAncestors.length > 0 &&
      openAncestors[openAncestors.length - 1].lineEnd < lineStart
    ) {
      openAncestors.pop();
    }
    const parentPath =
      openAncestors.length > 0
        ? openAncestors[openAncestors.length - 1].scopePath
        : '';

    const name = typeof m?.name === 'string' ? m.name : '';
    let segment;
    let anonymous;
    if (name === '' || ESCOMPLEX_ANON_LABEL_RE.test(name)) {
      const params = Array.isArray(m?.paramNames) ? m.paramNames : [];
      const signature = `(${params.join(',')})`;
      // NUL can never appear in a scope path; keep it an escape (a raw NUL
      // makes the file binary to git).
      const bucket = `${parentPath}\u0000${signature}`;
      const ordinal = ordinals.get(bucket) ?? 0;
      ordinals.set(bucket, ordinal + 1);
      segment = `${signature}#${ordinal}`;
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
  }

  return identities;
}
