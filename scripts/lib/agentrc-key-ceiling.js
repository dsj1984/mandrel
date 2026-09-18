/**
 * agentrc-key-ceiling.js — the ratchet on the size of the `.agentrc` surface
 * (Story #5382).
 *
 * Every leaf key in `AGENTRC_SCHEMA` is paid for several times over: in the
 * runtime schema, the generated JSON mirror, the precompiled validator, the
 * generated `configuration.md` table, and once more as a branch in whatever
 * code reads it. Story #5382 surveyed mandrel plus every consumer config it
 * could find and cut the schema from 183 leaf keys to 128 by removing keys no
 * config set. This ceiling keeps it there: a new key must displace an old one,
 * or the change must raise {@link AGENTRC_LEAF_KEY_CEILING} deliberately and
 * say why.
 *
 * A **leaf key** is a property whose schema is not itself an object with
 * declared `properties` (directly or through a `oneOf` / `anyOf` / `allOf`
 * branch). An open map such as `floors` or `components` counts once, however
 * many entries a consumer writes into it. Paths are de-duplicated, so a
 * property reachable through two composition branches counts once.
 */

/**
 * The landed leaf-key count. Raise it only in a change that also records why
 * the new key earns its place (docs/decisions.md).
 */
const AGENTRC_LEAF_KEY_CEILING = 128;

/**
 * Composition branches a JSON-Schema node may carry.
 *
 * @param {object} node
 * @returns {object[]}
 */
function branchesOf(node) {
  return [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])];
}

/**
 * True when `node` (or one of its composition branches) declares properties —
 * i.e. it is a namespace, not a leaf.
 *
 * @param {unknown} node
 * @returns {boolean}
 */
function declaresProperties(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.properties) return true;
  return branchesOf(node).some((branch) => Boolean(branch?.properties));
}

/**
 * Collect the dotted path of every leaf key under `schema`.
 *
 * @param {object} schema A JSON-Schema object (the runtime `AGENTRC_SCHEMA`).
 * @returns {string[]} Sorted, de-duplicated leaf paths.
 */
function collectLeafKeys(schema) {
  const leaves = new Set();
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const branch of branchesOf(node)) walk(branch, prefix);
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      if (declaresProperties(child)) walk(child, childPath);
      else leaves.add(childPath);
    }
  };
  walk(schema, '');
  return [...leaves].sort();
}

/**
 * Compare the schema's leaf count against the ceiling.
 *
 * @param {object} schema
 * @param {number} [ceiling]
 * @returns {{ leaves: string[], count: number, ceiling: number, ok: boolean }}
 */
export function checkLeafKeyCeiling(
  schema,
  ceiling = AGENTRC_LEAF_KEY_CEILING,
) {
  const leaves = collectLeafKeys(schema);
  return {
    leaves,
    count: leaves.length,
    ceiling,
    ok: leaves.length <= ceiling,
  };
}
