/**
 * escomplex-ast-compat.js — reconcile the `typhonjs-escomplex` code generator
 * with the Babel AST that `typhonjs-escomplex`'s own default parser emits.
 *
 * ## The upstream defect
 *
 * The kernel parses with `@babel/parser`, so every AST it analyses is a
 * **Babel** AST. But `typhonjs-escomplex-commons`'
 * `utils/ast/astSyntax.js` — the code generator that `ASTGenerator` drives —
 * was written against **ESTree**. The two disagree on node names
 * (`OptionalMemberExpression` vs a `MemberExpression` with `optional: true`)
 * and on node shapes (Babel's `RegExpLiteral` carries `pattern`/`flags`
 * directly; ESTree wraps them in a `regex` object on a `Literal`).
 *
 * That mismatch is invisible for most code because the metric traversal runs
 * off the syntax plugin's trait tables, not off `astSyntax`. `astSyntax` is
 * only reached where a trait re-serialises a **sub-AST** to synthesise a
 * Halstead operand or a function signature — nine traits do this:
 * `For`/`ForIn`/`ForOf` heads, `Function`/`FunctionExpression`/
 * `ArrowFunctionExpression` parameter lists, `Class`/`ClassExpression`
 * bodies, and `YieldExpression` arguments.
 *
 * Reach one of those with a Babel-only node and `analyzeModule()` throws —
 * aborting the whole module, not just the sub-expression. The constructs that
 * trip it are ordinary modern JavaScript:
 *
 * ```js
 * for (const t of s.split(/[^a-z]+/)) {}   // TypeError: …reading 'pattern'
 * for (const t of await xs()) {}           // …generator[node.type] is not a function
 * for (const t of a?.b) {}                 // …generator[node.type] is not a function
 * function f(a = () => import('x')) {}     // …this[node.callee.type] is not a function
 * function f(a = { ...b }) {}              // TypeError: …reading 'type'
 * function f(a = { m() {} }) {}            // TypeError: …reading 'generator'
 * function f(a = class { m() {} }) {}      // …this[statement.type] is not a function
 * ```
 *
 * The `{ ...b }` case is upstream issue #24, open and untouched since
 * 2020-12-16 with a byte-identical stack trace. The package last published in
 * June 2022 and the repo that holds the defective file has issues *disabled*,
 * so waiting for an upstream release is not a plan. Consumers of this kernel
 * previously absorbed the breakage as an allowlist of "unscorable" files that
 * grew every time someone wrote a `?.` in a loop head.
 *
 * ## What this module does
 *
 * Installs the missing handlers and repairs the two shape assumptions, on the
 * shared `astSyntax` table, once per process. Every patch is **conditional**:
 * a handler is only installed where the table lacks one, and the two repairs
 * wrap the original rather than replacing its behaviour. If a future kernel
 * bump fixes any of this upstream, the corresponding patch silently stops
 * applying and `install()` reports a shorter list — which
 * `tests/lib/escomplex-ast-compat.test.js` asserts on, so the shrinkage is
 * visible rather than silent.
 *
 * Nothing here changes the score of a file that already parses: the patched
 * paths are exactly the paths that previously threw.
 *
 * @see https://github.com/typhonjs-node-escomplex/typhonjs-escomplex/issues/24
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The package whose resolution anchors every `typhonjs-escomplex-commons` deep
 * import in this module.
 *
 * `escomplex-plugin-syntax-babylon` is the package that actually reads the
 * `astSyntax` table during a metric traversal, so its copy of `commons` is the
 * only one worth patching.
 *
 * Module-local on purpose. A test proves the binding by resolving from this
 * package's own root itself — which is the assertion worth making, since our
 * copy and the plugin's coincide under a hoisting installer and an
 * "ours === theirs" check would pass vacuously.
 */
const ANCHOR_PACKAGE = 'escomplex-plugin-syntax-babylon';

/** Marker set on every function this module installs, for idempotency. */
const PATCH_MARKER = Symbol.for('mandrel.escomplexAstCompat');

/** Memoised result of the one-time install. */
let installResult = null;

/**
 * Resolve the shared `astSyntax` generator table.
 *
 * This is a deep import into a transitive dependency's `dist/`, which is
 * exactly as fragile as it looks — hence the soft failure. If upstream ever
 * restructures, `install()` reports `available: false` and the engine falls
 * back to today's behaviour (unscorable files, now reported explicitly by
 * the engine rather than silently scored 0).
 *
 * The patch must land on the *same* `astSyntax` table the metric traversal
 * reads, and that table is resolved by **`escomplex-plugin-syntax-babylon`**,
 * from its own location — `PluginSyntaxBabylon` requires
 * `typhonjs-escomplex-commons/dist/utils/ast/ASTGenerator` and `ASTState` binds
 * the table it finds. So `commons` is anchored through the syntax plugin's
 * resolution, not through this module's and not through the kernel's.
 *
 * Resolving it from here, or from the kernel, would be a coin flip: under a
 * hoisting installer every copy usually coincides, but under pnpm's isolated
 * layout — or as soon as anything declares `commons` at a different version —
 * the plugin can read a *different* physical copy, and the patch then lands on
 * a table nobody reads while `install()` cheerfully reports success. Anchoring
 * on the reader makes that unreachable. Note this is why a test asserting
 * "our copy === the patched copy" proves nothing: under hoisting it passes
 * vacuously — a test must resolve from the plugin's own root instead.
 *
 * `requireFn` is the test seam: a cross-checkout verification harness passes
 * its own `createRequire` so the anchor starts from that checkout's plugin.
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
 * Tag a handler as ours so a second `install()` is a no-op.
 *
 * @template {Function} F
 * @param {F} fn
 * @returns {F}
 */
function mark(fn) {
  fn[PATCH_MARKER] = true;
  return fn;
}

/**
 * Install `name` only if the table has no handler for it. Returns whether the
 * install happened, so the caller can report the applied surface.
 *
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
 * Build an ESTree-shaped stand-in for a Babel `ObjectMethod` / `ClassMethod`,
 * whose function bits sit on the node itself rather than under `value`.
 * `MethodDefinition` reads `node.value.{generator,params,body}`, so handing it
 * a synthesized `value` lets the original handler do the work unchanged.
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
 * Patch the shared `astSyntax` table. Idempotent; safe to call from every
 * entry point that is about to run `analyzeModule`.
 *
 * @param {{ requireFn?: NodeJS.Require, memoise?: boolean }} [options] Test
 *   seam only — see {@link resolveSyntaxTable}. Production callers pass
 *   nothing.
 * @returns {{ available: boolean, applied: string[] }} `available` is false
 *   when the upstream internals could not be resolved. `applied` names each
 *   patch that was actually needed, so an upstream fix shows up as a
 *   shorter list.
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

  // ---- Repair 1: Babel's RegExpLiteral shape -------------------------------
  // Upstream reads `node.regex.pattern`, which only exists on an ESTree
  // `Literal`. Babel puts `pattern`/`flags` on the node. Wrapped rather than
  // replaced so the ESTree delegate path (`Literal` → `RegExpLiteral`) keeps
  // its exact original output.
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

  // ---- Repair 2: ObjectExpression's hard `this.Property()` dispatch --------
  // `ObjectExpression` calls `this.Property(el)` on every element regardless
  // of the element's actual type. Two Babel shapes get mis-routed by that:
  //
  //   `{ ...b }`    → a `SpreadElement` lands in `Property`, which reads
  //                   `node.key.type` and throws. Upstream issue #24.
  //   `{ m() {} }`  → an `ObjectMethod` has `kind: 'method'`, so `Property`'s
  //                   `node.kind[0] !== 'i'` test sends the raw Babel node to
  //                   `MethodDefinition`, which reads `node.value.generator`
  //                   and throws.
  //
  // Patching `Property` rather than `ObjectExpression` keeps the patch small
  // and leaves the indentation-sensitive object serialisation untouched:
  // anything arriving here that is not actually a property node gets
  // re-dispatched on its real type.
  //
  // `Property` and `ObjectProperty` are excluded from re-dispatch because the
  // table aliases `ObjectProperty` to `Property` — re-dispatching either would
  // recurse into this wrapper forever.
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

  // ---- Missing handlers: Babel-only node types ----------------------------

  // `await x` — mirrors upstream's `YieldExpression`.
  add('AwaitExpression', function AwaitExpression(node, state) {
    const output = state.output;
    output.write('await ');
    output.operators.push('await');
    if (node.argument) this[node.argument.type](node.argument, state);
  });

  // `a?.b` / `a?.[b]` — mirrors upstream's `MemberExpression`, with `?.`
  // recorded as its own operator so optional access is not counted as plain
  // member access.
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

  // `a?.()` — mirrors upstream's `CallExpression`.
  add('OptionalCallExpression', function OptionalCallExpression(node, state) {
    this[node.callee.type](node.callee, state);
    state.output.write('?.');
    state.output.operators.push('?.()');
    ASTUtil().formatSequence(node.arguments ?? [], state, this);
  });

  // The callee node of a dynamic `import(...)`. Babel models the `import`
  // keyword as its own node type; ESTree has no equivalent.
  add('Import', function Import(_node, state) {
    state.output.write('import');
    state.output.operators.push('import()');
  });

  // `{ m() {} }` / `{ get m() {} }` — Babel's ObjectMethod.
  add('ObjectMethod', function ObjectMethod(node, state) {
    return this.MethodDefinition(asMethodDefinition(node), state);
  });

  // `class { m() {} }` — Babel's ClassMethod (ESTree: MethodDefinition).
  add('ClassMethod', function ClassMethod(node, state) {
    return this.MethodDefinition(asMethodDefinition(node), state);
  });

  // `class { p = 1 }` — Babel's ClassProperty (ESTree: PropertyDefinition).
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
 * `ASTUtil` is only needed by the `OptionalCallExpression` handler, and only at
 * call time — resolving it lazily keeps `install()` free of a second deep
 * import that could fail at module load. Anchored through the syntax plugin
 * for the same reason as {@link resolveSyntaxTable}.
 *
 * `formatSequence` is a pure helper that takes the traveler and state as
 * arguments, so which copy answers is immaterial — but resolving it the same
 * way keeps one rule in this file rather than two.
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

// A test that needs to re-run the install against the already-patched table
// passes `{ memoise: false }` rather than resetting module state — the patches
// are self-detecting via PATCH_MARKER, so a non-memoised re-run is exactly the
// idempotency assertion worth making.
