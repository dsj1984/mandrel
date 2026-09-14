/**
 * escomplex-kernel.js — the complexity kernel's parse and dispatch layers,
 * in-repo.
 *
 * ## Why this file exists
 *
 * `typhonjs-escomplex` was a thin shell around four packages that do all the
 * actual work. The shell contributed two things: a parser front-end
 * (`@typhonjs/babel-parser`, a ~100-LOC shim over `@babel/parser`) and a
 * generic plugin bus (`typhonjs-plugin-manager`, used as a hardcoded
 * two-plugin synchronous dispatcher). Nine packages of plumbing hang off
 * those two, and none of it computes anything.
 *
 * What this does **not** do is remove `core-js@2`. Four of the retained
 * metric-core packages `require('babel-runtime/core-js/*')` themselves, so it
 * is load-bearing for the code that stays; a change that claimed otherwise
 * would be unshippable. What it buys instead is an honest closure —
 * `babel-runtime` is required by those packages and declared by none of them,
 * so today it resolves only because the removed plumbing hoists it. Declaring
 * it turns an accident into a contract.
 *
 * This module reimplements exactly those two layers over the retained metric
 * core — `typhonjs-escomplex-commons`, `escomplex-plugin-metrics-module`,
 * `escomplex-plugin-syntax-babylon`, `typhonjs-ast-walker` — which compute
 * every score. Nothing here computes a metric; the scores come from the same
 * packages as before, which is why they do not move.
 *
 * ## The equivalence contract
 *
 * Reproducing the displaced shell's *behaviour* means reproducing three
 * details it never documented:
 *
 * 1. **The parser's fixed plugin list**, verbatim and in order, with
 *    `sourceType: 'unambiguous'` — see `PARSER_PLUGINS` below. The list is
 *    what makes a `.ts` file, a decorator or a pipeline operator parse at
 *    all, and `unambiguous` is what lets a CommonJS script and an ES module
 *    both score.
 * 2. **Both plugin instances, in registration order** — syntax first, then
 *    metrics. The metrics plugin reads trait tables the syntax plugin put on
 *    the event.
 * 3. **One mutable event object per dispatch**, threaded through every plugin
 *    in turn, with the caller reading the mutations back off it. The displaced
 *    bus also stamped `$$plugin_invoke_count` / `$$plugin_invoke_names` onto
 *    every event's data; no plugin and no report reads them, so they are not
 *    reproduced.
 *
 * Equivalence is not asserted by reasoning: `tests/lib/escomplex-kernel.test.js`
 * replays a corpus captured under the displaced kernel *before* it left the
 * tree (`tests/fixtures/escomplex-kernel-parity/`), because afterwards there is
 * nothing left to compare against.
 *
 * ## The one uncontrolled input
 *
 * `.agents/` materializes into a consumer's repository root, so `@babel/parser`
 * resolves from **their** `node_modules`. The preflight guard checks presence,
 * not range, and `@babel/parser@8` is GA and rejects several names in the
 * fixed plugin list. A manifest range documents the requirement; it does not
 * enforce it. So the resolved major is asserted here, at load, with an error
 * that names the problem — rather than surfacing as an opaque plugin-list
 * syntax error partway through a scan.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
// Every metric-core package is reached by a STATIC import specifier with an
// explicit `.js` extension. That is not style: `tests/scripts/
// runtime-deps-drift.test.js` scans for literal `import`/`require` callees, so
// a package reached through an aliased `createRequire` would be a runtime
// dependency that is neither declared nor preflighted. The extensions are
// mandatory because `typhonjs-escomplex-commons` ships an empty
// `package.json` — no `main`, no `exports` — so a deep path is the only door.
import { parse as babelParse } from '@babel/parser';
import PluginMetricsModule from 'escomplex-plugin-metrics-module/dist/PluginMetricsModule.js';
import PluginSyntaxBabylon from 'escomplex-plugin-syntax-babylon/dist/PluginSyntaxBabylon.js';
import ASTWalker from 'typhonjs-ast-walker/dist/ASTWalker.js';
import ModuleScopeControl from 'typhonjs-escomplex-commons/dist/module/report/control/ModuleScopeControl.js';
import ModuleReport from 'typhonjs-escomplex-commons/dist/module/report/ModuleReport.js';
import { install as installAstCompat } from './escomplex-ast-compat.js';

/**
 * The only `@babel/parser` major this kernel supports.
 *
 * 8.x removed several plugin names from the fixed list below (they became
 * default syntax), so it does not merely warn — it throws on the plugin list
 * itself. Adopting it is a deliberate change with a baseline recut attached,
 * not something to absorb from a consumer's resolution.
 */
export const SUPPORTED_PARSER_MAJOR = 7;

/** Package whose resolved major gates this kernel. */
const PARSER_PACKAGE = '@babel/parser';

/**
 * The displaced parser shim's plugin list, verbatim and in order.
 *
 * Order is preserved because it is cheap to preserve, not because a
 * reordering is known to matter. The two entries with options
 * (`decorators`, `pipelineOperator`) carry the shim's exact settings —
 * `decoratorsBeforeExport: false` and the `minimal` pipeline proposal — which
 * decide whether decorated classes and `|>` parse. Re-cloned per parse so a
 * parser that mutated its options could not poison a later call.
 */
const PARSER_PLUGINS = [
  'asyncGenerators',
  'bigInt',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  ['decorators', { decoratorsBeforeExport: false }],
  'doExpressions',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'functionBind',
  'functionSent',
  'importMeta',
  'jsx',
  'logicalAssignment',
  'nullishCoalescingOperator',
  'numericSeparator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  ['pipelineOperator', { proposal: 'minimal' }],
  'throwExpressions',
  'typescript',
];

/**
 * The two plugins, in registration order: syntax populates the trait tables
 * the metrics plugin then reads. Neither defines `onPluginLoad`, and the
 * displaced bus was constructed without an eventbus, so there is no plugin
 * lifecycle or eventbus coupling to reproduce — only this list.
 */
const PLUGINS = [
  ['escomplex-plugin-syntax-babylon', new PluginSyntaxBabylon()],
  ['escomplex-plugin-metrics-module', new PluginMetricsModule()],
];

/** Memoised resolved parser version: `undefined` unread, `null` unresolvable. */
let parserVersion;

/**
 * Read the resolved `@babel/parser` version from its own manifest.
 *
 * The package exports no version, so its `package.json` is the only source.
 * This is the one non-static resolution in the file and it deliberately
 * targets a manifest rather than code: `@babel/parser` itself is reached by a
 * static import above, so it is declared and preflighted like every other
 * dependency.
 *
 * @returns {string|null} The resolved version, or `null` when the manifest
 *   cannot be read (a layout that hides `package.json` behind `exports`, say).
 */
function resolveParserVersion() {
  if (parserVersion !== undefined) return parserVersion;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${PARSER_PACKAGE}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    parserVersion = typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    parserVersion = null;
  }
  return parserVersion;
}

/**
 * The resolved parser's major version.
 *
 * @returns {number|null} `null` when the version could not be resolved or
 *   does not lead with an integer.
 */
export function resolveParserMajor() {
  const version = resolveParserVersion();
  if (version === null) return null;
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * Describe the resolved-parser problem, if there is one.
 *
 * Single-sourced so the load-time assertion below and the preflight guard
 * (`runtime-deps/ensure-installed.js`) emit the *same* named, actionable
 * message — the point of AC-5 is that a consumer never meets this as a
 * plugin-list syntax error mid-scan.
 *
 * An unresolvable version is **not** a problem: a consumer layout that hides
 * the manifest still resolves the parser itself, and refusing to score would
 * be a worse answer than scoring with an unverified parser. Only a
 * *known-wrong* major is reported.
 *
 * @param {{major?: number|null, version?: string|null}} [resolved] Overrides
 *   the resolved parser, so the message a consumer on an unsupported major
 *   would read is assertable without installing one.
 * @returns {string|null} The message, or `null` when the resolved parser is
 *   supported (or its version is unknowable).
 */
export function describeParserMajorError(resolved = {}) {
  const { major = resolveParserMajor(), version = resolveParserVersion() } =
    resolved;
  if (major === null || major === SUPPORTED_PARSER_MAJOR) return null;
  return (
    `unsupported ${PARSER_PACKAGE} major: resolved ${version}, ` +
    `the complexity kernel requires ${SUPPORTED_PARSER_MAJOR}.x. It parses ` +
    `with a fixed plugin list that later majors reject, so CRAP and ` +
    `maintainability scoring would fail mid-scan with an opaque plugin-list ` +
    `error. Declare "${PARSER_PACKAGE}": "^${SUPPORTED_PARSER_MAJOR}" in ` +
    `your package.json (see .agents/runtime-deps.json).`
  );
}

// The kernel's code generator predates the Babel AST its own parser emits, so
// ordinary modern syntax aborts a WHOLE module — see `escomplex-ast-compat.js`
// for the defect and the upstream status. Installing at the kernel rather than
// at each caller makes the next scoring entrypoint correct by construction.
installAstCompat();

const parserProblem = describeParserMajorError();
if (parserProblem !== null) {
  throw new Error(`[escomplex-kernel] ${parserProblem}`);
}

/**
 * Run one synchronous plugin dispatch.
 *
 * Reproduces the displaced bus's `invokeSyncEvents` for the degenerate shape
 * this kernel uses: no `copyProps` (the shell passed `void 0` at every call
 * site, so the merge base was always `{}`), no eventbus, and the caller
 * reading its results back off the same mutated `data` object every plugin
 * saw.
 *
 * @param {string} method Plugin method name, e.g. `onEnterNode`.
 * @param {object} passthru Properties placed on the event's `data`.
 * @returns {object} The event `data`, after every plugin has mutated it.
 */
function dispatch(method, passthru) {
  const event = {
    data: { ...passthru },
    extra: undefined,
    eventbus: undefined,
    pluginName: undefined,
    pluginOptions: undefined,
  };
  for (const [name, instance] of PLUGINS) {
    if (typeof instance[method] !== 'function') continue;
    event.pluginName = name;
    instance[method](event);
  }
  return event.data;
}

/**
 * The `ignoreKeys` a syntax trait wants withheld from the walker, if any.
 *
 * @param {object|undefined} syntax The trait entry for this node type.
 * @param {object} node
 * @param {object} parent
 * @returns {string[]}
 */
function traitIgnoreKeys(syntax, node, parent) {
  return typeof syntax === 'object' && syntax?.ignoreKeys
    ? syntax.ignoreKeys.valueOf(node, parent)
    : [];
}

/**
 * The new scope a syntax trait opens at this node, if any.
 *
 * @param {object|undefined} syntax The trait entry for this node type.
 * @param {object} node
 * @param {object} parent
 * @returns {object|null}
 */
function traitNewScope(syntax, node, parent) {
  if (typeof syntax !== 'object' || !syntax?.newScope) return null;
  return syntax.newScope.valueOf(node, parent) ?? null;
}

/**
 * Build the walker visitor for one module traversal.
 *
 * Split out of {@link analyzeModule} so the enter/exit symmetry is readable
 * side by side: each resolves the trait's scope, brackets the `scopeControl`
 * mutation with a pre/post dispatch, and straddles it with the node dispatch
 * in opposite order on the way in and out.
 *
 * The two event shapes are not interchangeable, and the difference is the
 * displaced shell's, not a simplification available here: node events carry
 * `syntaxes` and scope events do not, and a scope event names its scope
 * `newScope` on the way in but `scope` on the way out.
 *
 * @param {{
 *   moduleReport: object,
 *   scopeControl: object,
 *   syntaxes: Record<string, object>,
 *   settings: object,
 * }} context
 * @returns {{enterNode: Function, exitNode: Function}}
 */
function buildVisitor({ moduleReport, scopeControl, syntaxes, settings }) {
  const nodeBase = { moduleReport, scopeControl, syntaxes, settings };
  const scopeBase = { moduleReport, scopeControl, settings };
  return {
    enterNode(node, parent) {
      const syntax = syntaxes[node.type];
      const event = dispatch('onEnterNode', {
        ...nodeBase,
        ignoreKeys: traitIgnoreKeys(syntax, node, parent),
        node,
        parent,
      });
      const ignoreKeys = event !== null ? event.ignoreKeys : [];
      const newScope = traitNewScope(syntax, node, parent);
      if (newScope) {
        const scoped = { ...scopeBase, newScope, node, parent };
        dispatch('onModulePreScopeCreated', scoped);
        scopeControl.createScope(newScope);
        dispatch('onModulePostScopeCreated', scoped);
      }
      return ignoreKeys;
    },
    exitNode(node, parent) {
      const syntax = syntaxes[node.type];
      const newScope = traitNewScope(syntax, node, parent);
      if (newScope) {
        const scoped = { ...scopeBase, scope: newScope, node, parent };
        dispatch('onModulePreScopePopped', scoped);
        scopeControl.popScope(newScope);
        dispatch('onModulePostScopePopped', scoped);
      }
      dispatch('onExitNode', { ...nodeBase, node, parent });
    },
  };
}

/**
 * Parse and score one module.
 *
 * Drop-in replacement for the displaced `escomplex.analyzeModule(source)`:
 * same report object, same `finalize()` shape, same thrown errors for source
 * the kernel cannot handle.
 *
 * @param {string} source JavaScript (or TypeScript) source text.
 * @param {object} [options] Passed to the plugins' `onConfigure`, as before.
 * @returns {object} The finalized module report.
 * @throws {SyntaxError} Propagated from the parser, as before.
 */
export function analyzeModule(source, options = {}) {
  const ast = babelParse(source, {
    plugins: structuredClone(PARSER_PLUGINS),
    sourceType: 'unambiguous',
  });

  const settings = dispatch('onConfigure', { options, settings: {} }).settings;
  Object.freeze(settings);
  const syntaxes = dispatch('onLoadSyntax', {
    settings,
    syntaxes: {},
  }).syntaxes;

  const moduleReport = new ModuleReport(
    ast.loc.start.line,
    ast.loc.end.line,
    settings,
  );
  dispatch('onModuleStart', { ast, moduleReport, syntaxes, settings });

  const scopeControl = new ModuleScopeControl(moduleReport);
  new ASTWalker().traverse(
    ast,
    buildVisitor({ moduleReport, scopeControl, syntaxes, settings }),
  );

  for (const phase of [
    'onModuleCalculate',
    'onModuleAverage',
    'onModulePostAverage',
    'onModuleEnd',
  ]) {
    dispatch(phase, { moduleReport, syntaxes, settings });
  }

  return moduleReport.finalize();
}
