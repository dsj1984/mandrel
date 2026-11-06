/** Call-site anchors for unnamed functions, read from their AST parent chain. */

/** Nodes an anchor reads through: they do not change the call site. */
const TRANSPARENT_TYPES = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'AwaitExpression',
]);

const CALL_TYPES = new Set([
  'CallExpression',
  'NewExpression',
  'OptionalCallExpression',
]);

const KEYED_VALUE_TYPES = new Set([
  'ObjectProperty',
  'Property',
  'ClassProperty',
  'ClassPrivateProperty',
  'ClassAccessorProperty',
  'PropertyDefinition',
]);

/**
 * A static property name, or null for a computed non-literal one.
 *
 * @param {object} key
 * @param {boolean} computed
 * @returns {string|null}
 */
function staticKey(key, computed) {
  if (key?.type === 'StringLiteral') return key.value;
  if (key?.type === 'NumericLiteral') return String(key.value);
  if (computed) return null;
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'PrivateName') return key.id?.name ?? null;
  return null;
}

/**
 * `a.b.c` for a static member chain; a non-static link truncates the chain
 * to the static properties after it.
 *
 * @param {object} expr
 * @returns {string|null}
 */
function memberChain(expr) {
  if (expr?.type === 'Identifier') return expr.name;
  if (expr?.type === 'ThisExpression') return 'this';
  if (TRANSPARENT_TYPES.has(expr?.type)) return memberChain(expr.expression);
  if (
    expr?.type !== 'MemberExpression' &&
    expr?.type !== 'OptionalMemberExpression'
  ) {
    return null;
  }
  const prop = staticKey(expr.property, expr.computed);
  if (prop === null) return null;
  const head = memberChain(expr.object);
  return head === null ? prop : `${head}.${prop}`;
}

/**
 * @param {object} call
 * @returns {string|null}
 */
function calleeAnchor(call) {
  const callee = memberChain(call.callee);
  if (callee === null) return null;
  const first = call.arguments?.[0];
  return first?.type === 'StringLiteral' ? `${callee}:${first.value}` : callee;
}

/** @param {object} attr @returns {string|null} */
function jsxAttributeName(attr) {
  if (attr?.type !== 'JSXAttribute') return null;
  const n = attr.name;
  return n?.type === 'JSXNamespacedName'
    ? `${n.namespace.name}:${n.name.name}`
    : (n?.name ?? null);
}

/**
 * Per parent type: the anchor for `child` under `parent`, where
 * `ancestors[i]` is `parent`.
 */
const ANCHOR_BY_PARENT = new Map(
  Object.entries({
    JSXExpressionContainer: (_parent, _child, ancestors, i) =>
      jsxAttributeName(ancestors[i - 1]),
    ArrayExpression: (parent, _child, ancestors, i) =>
      anchorOf(parent, ancestors, i - 1),
    VariableDeclarator: (parent, child) =>
      parent.init === child && parent.id?.type === 'Identifier'
        ? parent.id.name
        : null,
    AssignmentExpression: (parent, child) =>
      parent.right === child ? memberChain(parent.left) : null,
  }),
);
for (const type of CALL_TYPES) {
  ANCHOR_BY_PARENT.set(type, (parent, child) =>
    parent.arguments?.includes(child) ? calleeAnchor(parent) : null,
  );
}
for (const type of KEYED_VALUE_TYPES) {
  ANCHOR_BY_PARENT.set(type, (parent, child) =>
    parent.value === child ? staticKey(parent.key, parent.computed) : null,
  );
}

/**
 * The call site of `node`, read from its parent chain; `ancestors[at]` is
 * its parent.
 *
 * @param {object} node
 * @param {object[]} ancestors
 * @param {number} at
 * @returns {string|null}
 */
export function anchorOf(node, ancestors, at) {
  let child = node;
  let i = at;
  while (i >= 0 && TRANSPARENT_TYPES.has(ancestors[i].type)) {
    child = ancestors[i];
    i -= 1;
  }
  const parent = ancestors[i];
  const rule = parent ? ANCHOR_BY_PARENT.get(parent.type) : undefined;
  return rule ? rule(parent, child, ancestors, i) : null;
}
