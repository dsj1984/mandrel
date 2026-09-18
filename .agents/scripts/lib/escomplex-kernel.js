/**
 * escomplex-kernel.js — in-repo parse and plugin-dispatch layers over the
 * retained metric core, which computes every score. A parity corpus pins
 * equivalence with the displaced shell. `@babel/parser` resolves from the
 * consumer's tree and v8 rejects the plugin list, so its major is asserted
 * at load.
 */

// Static `.js` specifiers: the drift test scans literal imports, and
// `commons` has no `main`/`exports`.
import { parse as babelParse } from '@babel/parser';
import PluginMetricsModule from 'escomplex-plugin-metrics-module/dist/PluginMetricsModule.js';
import PluginSyntaxBabylon from 'escomplex-plugin-syntax-babylon/dist/PluginSyntaxBabylon.js';
import ASTWalker from 'typhonjs-ast-walker/dist/ASTWalker.js';
import ModuleScopeControl from 'typhonjs-escomplex-commons/dist/module/report/control/ModuleScopeControl.js';
import ModuleReport from 'typhonjs-escomplex-commons/dist/module/report/ModuleReport.js';
import { install as installAstCompat } from './escomplex-ast-compat.js';
import { describeParserMajorError } from './runtime-deps/parser-major.js';

/** The displaced shim's list, verbatim; cloned per parse. */
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

/** Registration order matters: syntax populates what metrics reads. */
const PLUGINS = [
  ['escomplex-plugin-syntax-babylon', new PluginSyntaxBabylon()],
  ['escomplex-plugin-metrics-module', new PluginMetricsModule()],
];

installAstCompat();

const parserProblem = describeParserMajorError();
if (parserProblem !== null) {
  throw new Error(`[escomplex-kernel] ${parserProblem}`);
}

/**
 * Both plugins mutate the same `data`.
 *
 * @param {string} method
 * @param {object} passthru
 * @returns {object}
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
 * @param {object|undefined} syntax
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
 * @param {object|undefined} syntax
 * @param {object} node
 * @param {object} parent
 * @returns {object|null}
 */
function traitNewScope(syntax, node, parent) {
  if (typeof syntax !== 'object' || !syntax?.newScope) return null;
  return syntax.newScope.valueOf(node, parent) ?? null;
}

/**
 * Event shapes are the displaced shell's: scope events lack `syntaxes`, and
 * name the scope `newScope` on entry but `scope` on exit.
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
 * @param {string} source
 * @param {object} [options]
 * @returns {object}
 * @throws {SyntaxError}
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
