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
  if (!parent) return null;
  if (CALL_TYPES.has(parent.type)) {
    return parent.arguments?.includes(child) ? calleeAnchor(parent) : null;
  }
  if (parent.type === 'JSXExpressionContainer') {
    const attr = ancestors[i - 1];
    if (attr?.type !== 'JSXAttribute') return null;
    const n = attr.name;
    return n?.type === 'JSXNamespacedName'
      ? `${n.namespace.name}:${n.name.name}`
      : (n?.name ?? null);
  }
  if (KEYED_VALUE_TYPES.has(parent.type)) {
    return parent.value === child
      ? staticKey(parent.key, parent.computed)
      : null;
  }
  if (parent.type === 'ArrayExpression') {
    return anchorOf(parent, ancestors, i - 1);
  }
  if (parent.type === 'VariableDeclarator') {
    return parent.init === child && parent.id?.type === 'Identifier'
      ? parent.id.name
      : null;
  }
  if (parent.type === 'AssignmentExpression') {
    return parent.right === child ? memberChain(parent.left) : null;
  }
  return null;
}
