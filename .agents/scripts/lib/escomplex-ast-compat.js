/**
 * escomplex-ast-compat.js — patch the ESTree-written `astSyntax` code
 * generator for the Babel AST the kernel parses. A Babel-only node in a
 * re-serialised sub-AST (loop head, parameter default) otherwise throws for
 * the whole module; upstream is unmaintained. Patches are conditional, so an
 * upstream fix shrinks `applied` (a test asserts it); parseable files score
 * unchanged.
 *
 * @see https://github.com/typhonjs-node-escomplex/typhonjs-escomplex/issues/24
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Reads `astSyntax` during traversal, so its copy is the one to patch. */
const ANCHOR_PACKAGE = 'escomplex-plugin-syntax-babylon';

const PATCH_MARKER = Symbol.for('mandrel.escomplexAstCompat');

let installResult = null;

/**
 * Anchored through the reader plugin — under pnpm a copy resolved from here
 * could be one nobody reads. A fragile deep import, so failure is soft.
 *
 * @param {NodeJS.Require} [requireFn]
 * @returns {Record<string, Function>|null}
 */
function resolveSyntaxTable(requireFn = require) {
  try {
    const fromReader = createRequire(requireFn.resolve(ANCHOR_PACKAGE));
    const mod = fromReader(
      'typhonjs-escomplex-commons/dist/utils/ast/astSyntax.js',
    );
    const table = mod?.default ?? mod;
    if (!table || typeof table !== 'object') return null;
    // Sanity-check that this is the table we think it is before mutating it.
    if (typeof table.MemberExpression !== 'function') return null;
    if (Object.isFrozen(table)) return null;
    return table;
  } catch {
    return null;
  }
}

/**
 * @template {Function} F
 * @param {F} fn
 * @returns {F}
 */
function mark(fn) {
  fn[PATCH_MARKER] = true;
  return fn;
}

/**
 * @param {Record<string, Function>} table
 * @param {string} name
 * @param {Function} handler
 * @returns {boolean}
 */
function addMissing(table, name, handler) {
  if (typeof table[name] === 'function') return false;
  table[name] = mark(handler);
  return true;
}

/**
 * Moves a Babel method's function bits under `value` for `MethodDefinition`.
 *
 * @param {object} node
 * @returns {object}
 */
function asMethodDefinition(node) {
  return {
    ...node,
    kind:
      typeof node.kind === 'string' && node.kind.length > 0
        ? node.kind
        : 'init',
    value: {
      type: 'FunctionExpression',
      generator: Boolean(node.generator),
      async: Boolean(node.async),
      params: node.params ?? [],
      body: node.body,
    },
  };
}

/**
 * Idempotent via PATCH_MARKER.
 *
 * @param {{ requireFn?: NodeJS.Require, memoise?: boolean }} [options]
 * @returns {{ available: boolean, applied: string[] }}
 */
export function install(options = {}) {
  const { requireFn, memoise = true } = options;
  if (memoise && installResult !== null) return installResult;

  const table = resolveSyntaxTable(requireFn);
  if (table === null) {
    const unavailable = { available: false, applied: [] };
    if (memoise) installResult = unavailable;
    return unavailable;
  }

  const applied = [];
  const add = (name, handler) => {
    if (addMissing(table, name, handler)) applied.push(name);
  };

  // Babel puts `pattern`/`flags` on the node; upstream reads `node.regex`.
  // Wrapped so the ESTree `Literal` delegate path keeps its exact output.
  if (
    typeof table.RegExpLiteral === 'function' &&
    !table.RegExpLiteral[PATCH_MARKER]
  ) {
    const original = table.RegExpLiteral;
    table.RegExpLiteral = mark(function RegExpLiteral(node, state) {
      if (node?.regex === undefined) {
        state.output.write(
          `new RegExp(${JSON.stringify(node?.pattern ?? '')}, ` +
            `${JSON.stringify(node?.flags ?? '')})`,
        );
        return;
      }
      return original.call(this, node, state);
    });
    applied.push('RegExpLiteral');
  }

  // `ObjectExpression` calls `this.Property(el)` for every element, so a
  // `SpreadElement` or `ObjectMethod` is mis-routed and throws. Re-dispatch
  // non-property nodes on their real type. `Property`/`ObjectProperty` are
  // excluded: the table aliases them, so re-dispatch would recurse forever.
  if (typeof table.Property === 'function' && !table.Property[PATCH_MARKER]) {
    const original = table.Property;
    const PROPERTY_TYPES = new Set(['Property', 'ObjectProperty']);
    table.Property = mark(function Property(node, state) {
      const type = node?.type;
      if (
        typeof type === 'string' &&
        !PROPERTY_TYPES.has(type) &&
        typeof this[type] === 'function'
      ) {
        return this[type](node, state);
      }
      return original.call(this, node, state);
    });
    applied.push('Property');
  }

  add('AwaitExpression', function AwaitExpression(node, state) {
    const output = state.output;
    output.write('await ');
    output.operators.push('await');
    if (node.argument) this[node.argument.type](node.argument, state);
  });

  // `?.` is its own operator, not counted as plain member access.
  add(
    'OptionalMemberExpression',
    function OptionalMemberExpression(node, state) {
      const output = state.output;
      this[node.object.type](node.object, state);
      if (node.computed) {
        output.write('?.[');
        this[node.property.type](node.property, state);
        output.write(']');
        output.operators.push('?.[]');
      } else {
        output.write('?.');
        output.operators.push('?.');
        this[node.property.type](node.property, state);
      }
    },
  );

  add('OptionalCallExpression', function OptionalCallExpression(node, state) {
    this[node.callee.type](node.callee, state);
    state.output.write('?.');
    state.output.operators.push('?.()');
    ASTUtil().formatSequence(node.arguments ?? [], state, this);
  });

  // Callee of a dynamic `import(...)`; ESTree has no equivalent node.
  add('Import', function Import(_node, state) {
    state.output.write('import');
    state.output.operators.push('import()');
  });

  add('ObjectMethod', function ObjectMethod(node, state) {
    return this.MethodDefinition(asMethodDefinition(node), state);
  });

  add('ClassMethod', function ClassMethod(node, state) {
    return this.MethodDefinition(asMethodDefinition(node), state);
  });

  const classProperty = function ClassProperty(node, state) {
    const output = state.output;
    if (node.static) {
      output.write('static ');
      output.operators.push('static');
    }
    if (node.computed) {
      output.write('[');
      this[node.key.type](node.key, state);
      output.write(']');
    } else {
      this[node.key.type](node.key, state);
    }
    if (node.value) {
      output.write(' = ');
      output.operators.push('=');
      this[node.value.type](node.value, state);
    }
    output.write(';');
  };
  add('ClassProperty', classProperty);
  add('PropertyDefinition', classProperty);

  const result = { available: true, applied };
  if (memoise) installResult = result;
  return result;
}

/**
 * Lazy, so `install()` has no second deep import that could fail at load.
 *
 * @returns {{ formatSequence: Function }}
 */
function ASTUtil() {
  const fromReader = createRequire(require.resolve(ANCHOR_PACKAGE));
  const mod = fromReader(
    'typhonjs-escomplex-commons/dist/utils/ast/ASTUtil.js',
  );
  return mod?.default ?? mod;
}
