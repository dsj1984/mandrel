/**
 * escomplex-ast-compat.test.js — the Babel-AST constructs that used to abort a
 * whole module's maintainability analysis.
 *
 * Each case below is a one-line reduction of a real crash observed on a
 * consumer's tree. The kernel's code generator was written for ESTree while its
 * own parser emits Babel, so any of these reached through a serialised sub-AST
 * (loop head, parameter list, class body, yield argument) threw and took the
 * entire file's score with it — which the pipeline then swallowed as `0` and
 * dropped from the baseline.
 *
 * The three guards that matter:
 *   1. every construct scores (no throw, finite index);
 *   2. genuinely invalid syntax is still reported unscorable — the shim must
 *      not paper over real parse errors;
 *   3. the patch is additive — a file that already scored keeps its exact
 *      score, so installing this cannot move a committed baseline row.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { install } from '../../.agents/scripts/lib/escomplex-ast-compat.js';
import { scoreSource } from '../../.agents/scripts/lib/maintainability-engine.js';

/**
 * The score an unscorable result carries. Asserted as a literal rather than
 * imported, because the *value* is deliberately not public API: `unscorable` is
 * the signal a caller branches on, and overloading a score with out-of-band
 * meaning is the bug this change exists to stop propagating.
 */
const UNSCORABLE_SCORE = 0;

/**
 * Constructs that crashed the kernel before this shim. The comment on each is
 * the error it produced.
 */
const RESCUED_CONSTRUCTS = {
  // TypeError: Cannot read properties of undefined (reading 'pattern')
  'regex literal in a for-of head': 'for (const t of s.split(/a+/)) { x(t); }',
  'regex literal in a parameter default': 'function f(a = /x/) { return a; }',
  // TypeError: state.generator[node.type] is not a function
  'await in a for-of head':
    'async function f() { for (const t of await g()) { x(t); } }',
  'optional member in a for-of head': 'for (const t of a?.b) { x(t); }',
  'optional call in a for-of head': 'for (const t of a?.()) { x(t); }',
  'chained optional call in a for-of head':
    'for (const t of a?.b?.()) { x(t); }',
  // TypeError: this[node.callee.type] is not a function
  'dynamic import in a parameter default':
    'function f(a = () => import("x")) { return a; }',
  // TypeError: Cannot read properties of undefined (reading 'type') — upstream #24
  'object spread in a parameter default':
    'function f({ a = { ...b } } = {}) { return a; }',
  'object spread in a for-of head': 'for (const t of [{ ...b }]) { x(t); }',
  // TypeError: Cannot read properties of undefined (reading 'generator')
  'object method in a parameter default':
    'function f(a = { m() { return 1; } }) { return a; }',
  'object getter in a parameter default':
    'function f(a = { get m() { return 1; } }) { return a; }',
  'object setter in a parameter default':
    'function f(a = { set m(v) { this.x = v; } }) { return a; }',
  'async object method in a parameter default':
    'function f(a = { async m() { return 1; } }) { return a; }',
  'generator object method in a parameter default':
    'function f(a = { *m() { yield 1; } }) { return a; }',
  // TypeError: this[statement.type] is not a function
  'class method in a parameter default':
    'function f(a = class { m() { return 1; } }) { return a; }',
  'class property in a parameter default':
    'function f(a = class { p = 1; }) { return a; }',
};

/** Ordinary code that always scored — the no-drift control group. */
const ALREADY_SCORABLE = {
  'plain for-of': 'for (const t of xs) { x(t); }',
  'plain object literal': 'function f(a = { b: 1 }) { return a; }',
  'shorthand properties': 'function f(a = { b, c }) { return a; }',
  'computed key': 'function f(a = { [k]: 1 }) { return a; }',
  'array spread': 'function f(a = [...b]) { return a; }',
  'object rest in a destructured param':
    'function f({ a, ...rest }) { return rest; }',
  // Written as a template literal with escapes so the linter does not read the
  // interpolation-in-a-plain-string as a mistake — it is fixture source, not a
  // string we mean to interpolate.
  'template literal default': `function f(a = \`x\${b}y\`) { return a; }`,
  'nullish coalescing default': 'function f(a = b ?? c) { return a; }',
  'async arrow default': 'function f(a = async () => 1) { return a; }',
  'spread argument': 'function f(a = g(...b)) { return a; }',
  'yield a regex': 'function* f() { yield /x/; }',
  'class with a member-expression superclass':
    'function f(a = class extends b.c {}) { return a; }',
};

describe('escomplex-ast-compat', () => {
  it('resolves the upstream generator table and reports what it patched', () => {
    const report = install();
    assert.equal(
      report.available,
      true,
      'could not resolve typhonjs-escomplex-commons astSyntax — the deep import ' +
        'has moved; install() correctly degrades, but the shim is now inert',
    );
    assert.ok(
      report.applied.length > 0,
      'nothing was patched — if the kernel was bumped and fixed upstream, delete ' +
        'the corresponding branch in escomplex-ast-compat.js and the allowlists ' +
        'that reference it',
    );
  });

  it('patches the astSyntax copy the syntax plugin itself reads', () => {
    // The table the metric traversal consults is resolved by
    // `escomplex-plugin-syntax-babylon`, from its own location:
    // `PluginSyntaxBabylon` requires `.../ASTGenerator` and `ASTState` binds
    // whatever `astSyntax` that resolution finds. So the patch has to land on
    // the plugin's copy, not on ours and not on the kernel's.
    //
    // This resolves from the PLUGIN's root deliberately. Asserting
    // "our copy === the patched copy" would prove nothing: under a hoisting
    // installer every copy coincides.
    //
    // What this test does and does not buy, stated plainly: in a hoisted tree
    // it cannot fail, because there is only one physical `commons`. Its value
    // is that it pins the *anchor* — re-point `ANCHOR_PACKAGE` at a package
    // that is not the table's reader and this assertion is the thing that has
    // to be reasoned about again. A non-vacuous version needs a tree with two
    // `commons` copies, which no fixture here builds.
    const fromPlugin = createRequire(
      createRequire(import.meta.url).resolve('escomplex-plugin-syntax-babylon'),
    );
    const pluginsTable = fromPlugin(
      'typhonjs-escomplex-commons/dist/utils/ast/astSyntax.js',
    );
    const table = pluginsTable?.default ?? pluginsTable;

    const result = install();
    assert.equal(result.available, true);
    assert.ok(result.applied.length > 0);

    // Every name `install()` reports patching must carry the marker on the
    // table the plugin reads — that is what "the patch is bound" means.
    const marker = Symbol.for('mandrel.escomplexAstCompat');
    for (const name of result.applied) {
      assert.equal(
        typeof table[name],
        'function',
        `${name} missing from the plugin's astSyntax table`,
      );
      assert.ok(
        table[name][marker],
        `${name} is patched on a different copy than the plugin reads`,
      );
    }
  });

  it('is idempotent', () => {
    const first = install();
    const second = install();
    assert.deepEqual(second, first);

    // A non-memoised re-run bypasses the memo and re-examines the real table,
    // which must now have nothing left to add — proving the patches are
    // self-detecting and a second install cannot double-wrap a handler.
    const rerun = install({ memoise: false });
    assert.deepEqual(
      rerun.applied,
      [],
      'a second install re-applied patches — PATCH_MARKER detection is broken, ' +
        'which would stack wrappers and change scores',
    );
  });

  for (const [name, source] of Object.entries(RESCUED_CONSTRUCTS)) {
    it(`scores ${name}`, () => {
      const result = scoreSource(source);
      assert.equal(
        result.unscorable,
        false,
        `still unscorable: ${result.reason}`,
      );
      assert.ok(
        Number.isFinite(result.score) && result.score > 0,
        `expected a finite positive index, got ${result.score}`,
      );
    });
  }

  for (const [name, source] of Object.entries(ALREADY_SCORABLE)) {
    it(`still scores ${name}`, () => {
      const result = scoreSource(source);
      assert.equal(result.unscorable, false, `regressed: ${result.reason}`);
      assert.ok(Number.isFinite(result.score) && result.score > 0);
    });
  }

  it('still reports genuinely invalid syntax as unscorable', () => {
    const result = scoreSource('function ( { ] }');
    assert.equal(result.unscorable, true);
    assert.equal(result.score, UNSCORABLE_SCORE);
    assert.match(result.reason, /SyntaxError/);
  });

  it('distinguishes unscorable from a genuinely low score', () => {
    const unscorable = scoreSource('function ( { ] }');
    const scored = scoreSource('for (const t of xs) { x(t); }');

    assert.equal(unscorable.score, UNSCORABLE_SCORE);
    assert.equal(unscorable.unscorable, true);
    assert.notEqual(
      scored.score,
      UNSCORABLE_SCORE,
      'the control must not collide with the unscorable sentinel',
    );
    assert.equal(scored.unscorable, false);
    assert.equal(scored.reason, null);
    assert.ok(
      typeof unscorable.reason === 'string' && unscorable.reason.length > 0,
      'an unscorable result must carry a reason a human can act on',
    );
  });
});
