#!/usr/bin/env node

// Static gate over a Gherkin corpus: every in-scope `.feature` must compile
// with the REAL `@cucumber/gherkin` parser (a hand-rolled reader skips what it
// cannot parse and reads clean), then every active step must bind under its own
// scope. A file failing to compile is excluded from must-bind: it parses as an
// arbitrary subset and would bury the syntax error under invented findings.
// The parser is an optional peer resolved from the consumer root, since
// `.agents/` is a plain file copy and a bare specifier need not resolve there.

import fs, { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  buildStepIndex,
  listFeatureFiles,
  listStepFiles,
  matchStep,
} from './lib/bdd-step-index.js';
import { runAsCli } from './lib/cli-utils.js';
import { getGherkinLint } from './lib/config/qa.js';
import { resolveConfig } from './lib/config-resolver.js';

const TAG = '[gherkin-corpus]';
const PARSER_PACKAGE = '@cucumber/gherkin';

const HELP = {
  invocation: 'node .agents/scripts/check-gherkin-corpus.js [--cwd <dir>]',
  summary:
    'Static gate over the Gherkin corpus: every in-scope .feature must compile with the real parser, and every active step must bind to a definition under its own scope.',
  flags: [['--cwd <dir>', 'Project root to check. Default: process.cwd().']],
  notes: [
    'Opt-in: the gate runs only when `qa.gherkinLint` is configured in .agentrc.json.',
    'Escapes for a false unbound: `exemptionTags` (default ["@skip"]) and `stepWaivers`.',
    'Exit codes:\n  0  clean, or not configured\n  1  parse error, unbound step, or a fail-closed condition',
  ],
};

/**
 * @param {string[]} argv
 * @returns {{ cwd: string | null }}
 */
export function parseArgs(argv = []) {
  const out = { cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cwd') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.cwd = next;
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Resolves from the checked project first, then the framework's own install.
 * @param {{ cwd: string }} params
 * @returns {Promise<{ parse: (source: string) => object }>}
 * @throws {Error}
 */
export async function loadGherkinParser({ cwd }) {
  const anchors = [
    createRequire(path.join(path.resolve(cwd), 'noop.cjs')),
    createRequire(import.meta.url),
  ];
  let resolved = null;
  for (const anchor of anchors) {
    try {
      resolved = anchor.resolve(PARSER_PACKAGE);
      break;
    } catch {
      // Next anchor; the caller reports the aggregate failure.
    }
  }
  if (!resolved) {
    throw new Error(
      `${PARSER_PACKAGE} could not be resolved from ${path.resolve(cwd)} or from the framework's own install — install it with \`npm install --save-dev ${PARSER_PACKAGE}\``,
    );
  }
  const { AstBuilder, GherkinClassicTokenMatcher, Parser } = await import(
    pathToFileURL(resolved).href
  );
  return {
    parse(source) {
      // Local id counter, so `@cucumber/messages` is not a second import.
      let seq = 0;
      const nextId = () => {
        seq += 1;
        return String(seq);
      };
      const parser = new Parser(
        new AstBuilder(nextId),
        new GherkinClassicTokenMatcher(),
      );
      return parser.parse(source);
    },
  };
}

/**
 * @param {unknown} error
 * @param {string} file
 * @returns {Array<{ kind: 'parse-error', file: string, line: number, column: number, message: string }>}
 */
export function toParseFindings(error, file) {
  const reported = Array.isArray(error?.errors) ? error.errors : [error];
  return reported.map((entry) => ({
    kind: 'parse-error',
    file,
    line: entry?.location?.line ?? 1,
    column: entry?.location?.column ?? 1,
    message: String(entry?.message ?? entry),
  }));
}

function tagNames(node) {
  return (node?.tags ?? []).map((tag) => tag.name);
}

/**
 * @param {string} text
 * @param {Array<{ tableHeader?: object, tableBody?: object[] }>} examples
 * @returns {string[]}
 */
export function expandStepText(text, examples) {
  if (!text.includes('<')) return [text];
  const variants = [];
  for (const example of examples ?? []) {
    const headers = (example?.tableHeader?.cells ?? []).map((c) => c.value);
    for (const row of example?.tableBody ?? []) {
      const cells = (row?.cells ?? []).map((c) => c.value);
      let expanded = text;
      headers.forEach((header, i) => {
        expanded = expanded.split(`<${header}>`).join(cells[i] ?? '');
      });
      variants.push(expanded);
    }
  }
  return variants.length > 0 ? variants : [text];
}

/**
 * Background steps are checked once, and only while their container still
 * holds a non-exempt scenario.
 * @param {object} feature
 * @param {string[]} exemptionTags
 * @returns {Array<{ line: number, text: string, examples: object[] }>}
 */
export function collectActiveSteps(feature, exemptionTags) {
  const exempt = new Set(exemptionTags);
  const featureTags = tagNames(feature);
  const steps = [];

  // Keyed by line: under Rules one background is inherited by many containers.
  const emittedBackgroundLines = new Set();
  const pushBackgroundSteps = (backgrounds) => {
    for (const background of backgrounds) {
      for (const step of background.steps ?? []) {
        if (emittedBackgroundLines.has(step.location.line)) continue;
        emittedBackgroundLines.add(step.location.line);
        steps.push({ line: step.location.line, text: step.text, examples: [] });
      }
    }
  };

  const walkContainer = (container, inheritedTags, inheritedBackgrounds) => {
    const backgrounds = [...inheritedBackgrounds];
    const scenarios = [];
    for (const child of container?.children ?? []) {
      if (child.background) backgrounds.push(child.background);
      if (child.scenario) scenarios.push(child.scenario);
    }
    // Recurse before the no-active-scenarios return, so a feature whose
    // scenarios all live under Rules still has its Background checked.
    for (const child of container?.children ?? []) {
      if (!child.rule) continue;
      walkContainer(
        child.rule,
        [...inheritedTags, ...tagNames(child.rule)],
        backgrounds,
      );
    }
    const active = scenarios.filter(
      (scenario) =>
        ![...inheritedTags, ...tagNames(scenario)].some((tag) =>
          exempt.has(tag),
        ),
    );
    if (active.length === 0) return;
    pushBackgroundSteps(backgrounds);
    for (const scenario of active) {
      for (const step of scenario.steps ?? []) {
        steps.push({
          line: step.location.line,
          text: step.text,
          examples: scenario.examples ?? [],
        });
      }
    }
  };

  walkContainer(feature, featureTags, []);
  return steps;
}

/**
 * Bound when ANY Examples expansion matches: a partial bind is almost always
 * an index parameter-type mismatch, not a corpus defect.
 * @returns {Array<{ kind: 'unbound', file: string, line: number, text: string, scope: string }>}
 */
function bindFindings({ feature, file, scope, index, exemptionTags, waivers }) {
  const findings = [];
  const seen = new Set();
  for (const step of collectActiveSteps(feature, exemptionTags)) {
    if (waivers.has(step.text)) continue;
    const key = `${step.line}|${step.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const variants = expandStepText(step.text, step.examples);
    if (variants.some((variant) => matchStep(index, variant))) continue;
    findings.push({
      kind: 'unbound',
      file,
      line: step.line,
      text: step.text,
      scope: scope.name,
    });
  }
  return findings;
}

/**
 * @returns {{ findings: object[], featureCount: number, stepDefinitionCount: number }}
 */
export function scanScope({
  scope,
  cwd,
  parser,
  exemptionTags,
  waivers,
  readFile,
}) {
  const featureFiles = listFeatureFiles(
    scope.featureRoots.map((root) => path.resolve(cwd, root)),
  ).sort();
  const stepFiles = listStepFiles(
    scope.stepRoots.map((root) => path.resolve(cwd, root)),
  );
  const index = buildStepIndex({ files: stepFiles, readFile });
  const findings = [];

  for (const absolute of featureFiles) {
    const file = path.relative(cwd, absolute);
    let document;
    try {
      document = parser.parse(
        readFile ? readFile(absolute) : readFileSync(absolute, 'utf8'),
      );
    } catch (error) {
      findings.push(...toParseFindings(error, file));
      continue;
    }
    if (!document?.feature) continue;
    findings.push(
      ...bindFindings({
        feature: document.feature,
        file,
        scope,
        index,
        exemptionTags,
        waivers,
      }),
    );
  }

  return {
    findings,
    featureCount: featureFiles.length,
    stepDefinitionCount: index.entries.length,
  };
}

/**
 * A missing featureRoot is a blackout (green over an unchecked corpus); an
 * existing but empty one is a legitimate not-yet-written corpus.
 * @param {Array<{ name: string, featureRoots: string[] }>} scopes
 * @param {string} root
 * @returns {string | null}
 */
function findMissingFeatureRoots(scopes, root) {
  for (const scope of scopes) {
    const missing = scope.featureRoots.filter(
      (r) => !fs.existsSync(path.resolve(root, r)),
    );
    if (missing.length === 0) continue;
    return (
      `scope "${scope.name}" names featureRoots that do not exist: ${missing.join(', ')} — ` +
      'every feature in this scope would go unchecked, which is a blackout, ' +
      "not a clean run. Point featureRoots at the directory holding this scope's .feature files."
    );
  }
  return null;
}

export function renderFinding(finding) {
  if (finding.kind === 'parse-error') {
    return `${TAG} parse-error ${finding.file}:${finding.line}:${finding.column} ${finding.message}`;
  }
  return `${TAG} unbound [${finding.scope}] ${finding.file}:${finding.line} ${finding.text}`;
}

/**
 * @returns {Promise<number>}
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  loadParser = loadGherkinParser,
  readFile,
} = {}) {
  const args = parseArgs(argv);
  const root = path.resolve(args.cwd ?? cwd);
  const config = resolveConfig({ cwd: root, bustCache: true });
  const contract = getGherkinLint(config);

  if (!contract) {
    stdout.write(
      `${TAG} not configured — add a \`qa.gherkinLint\` block to .agentrc.json to enable this gate.\n`,
    );
    return 0;
  }

  const blackout = findMissingFeatureRoots(contract.scopes, root);
  if (blackout) {
    stderr.write(`${TAG} ❌ ${blackout}\n`);
    return 1;
  }

  const corpusSize = contract.scopes.reduce(
    (total, scope) =>
      total +
      listFeatureFiles(scope.featureRoots.map((r) => path.resolve(root, r)))
        .length,
    0,
  );
  if (corpusSize === 0) {
    stdout.write(`${TAG} no .feature files in scope — nothing to check.\n`);
    return 0;
  }

  let parser;
  try {
    parser = await loadParser({ cwd: root });
  } catch (error) {
    stderr.write(`${TAG} ❌ ${error.message}\n`);
    return 1;
  }

  const waivers = new Set(contract.stepWaivers);
  const findings = [];
  let checked = 0;

  for (const scope of contract.scopes) {
    const result = scanScope({
      scope,
      cwd: root,
      parser,
      exemptionTags: contract.exemptionTags,
      waivers,
      readFile,
    });
    if (result.featureCount > 0 && result.stepDefinitionCount === 0) {
      stderr.write(
        `${TAG} ❌ scope "${scope.name}" resolved 0 step definitions from stepRoots: ${scope.stepRoots.join(', ')} — every step would report unbound, which is a blackout, not a finding. Point stepRoots at the directory holding this scope's step definitions.\n`,
      );
      return 1;
    }
    checked += result.featureCount;
    findings.push(...result.findings);
  }

  if (findings.length === 0) {
    stdout.write(`${TAG} ✅ ${checked} feature file(s) compile and bind.\n`);
    return 0;
  }
  for (const finding of findings) stderr.write(`${renderFinding(finding)}\n`);
  stderr.write(
    `${TAG} ❌ ${findings.length} finding(s) across ${checked} feature file(s).\n`,
  );
  return 1;
}

runAsCli(import.meta.url, () => runCli(), {
  source: 'gherkin-corpus',
  propagateExitCode: true,
  errorPrefix: `${TAG} ❌ Fatal error`,
  usage: HELP,
});
