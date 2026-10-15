// lib/cli/doctor-checks/test-credit-path.js — Doctor check: test-credit-path.

import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from './read-json.js';

// check: test-credit-path

/** The runner whose green full run deposits the close `test` credit itself. */
const MANDREL_TEST_RUNNER = 'run-tests.js';

/** The close `test` gate's command when `project.commands.test` is unset. */
const DEFAULT_TEST_COMMAND = 'npm test';

/**
 * The deposit command that works on any runner, wrapping `command`.
 *
 * @param {string} command
 * @returns {string}
 */
function testCreditDepositCommand(command) {
  return `node .agents/scripts/evidence-gate.js --standalone --scope-id <storyId> --gate test --worktree <workCwd> -- ${command}`;
}

/** The capture close's `coverage-capture` gate finds fresh, per digest § 5. */
const COVERAGE_CAPTURE_COMMAND =
  'node .agents/scripts/coverage-capture.js --cwd <workCwd>';

/** The worker's one tail command; it runs whichever depositor applies. */
const STORY_HANDOFF_COMMAND =
  'node .agents/scripts/story-handoff.js --story <storyId> --cwd <workCwd>';

/**
 * @param {string} command
 * @returns {string}
 */
function testCreditRemedy(command) {
  return `run the suite through the depositor instead of bare \`${command}\`: ${testCreditDepositCommand(command)}`;
}

const PRE_PUSH_REMEDY =
  'wrap each hook gate in `node .agents/scripts/evidence-gate.js --standalone --scope-id <storyId> --gate <typecheck|lint> -- <command>` so the push deposits the credit close reads';

/** A hook line that runs a typecheck or lint gate. */
const HOOK_GATE_RE = /\b(typecheck|tsc|lint|eslint|biome)\b/;

/**
 * The hook minus its comment lines: a comment that mentions lint runs nothing.
 *
 * @param {string} hook
 * @returns {string}
 */
function hookCommandLines(hook) {
  return hook
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Consulted only while `project.commands.test` is unset — then the close
 * gate's argv is `npm test`, which runs `scripts.test`.
 *
 * @param {string} projectRoot
 * @param {typeof fs.readFileSync} readFileImpl
 * @returns {Record<string, string>} The `scripts` map, empty when unreadable.
 */
function readProjectScripts(projectRoot, readFileImpl) {
  try {
    const raw = readFileImpl(path.join(projectRoot, 'package.json'), 'utf8');
    const scripts = JSON.parse(raw)?.scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string>} scripts
 * @param {string} name
 * @returns {string|null} The trimmed script, or null when there is none.
 */
function scriptNamed(scripts, name) {
  const script = scripts[name];
  return typeof script === 'string' && script.trim().length > 0
    ? script.trim()
    : null;
}

/**
 * `delivery.quality.gates.crap.enabled` from `.agentrc.json` overlaid by
 * `.agentrc.local.json`, defaulting on — the predicate close registers
 * `coverage-capture` on. Read without `resolveConfig()` (built-ins only).
 *
 * @param {string} projectRoot
 * @param {typeof fs.readFileSync} readFileImpl
 * @returns {boolean}
 */
function isCrapEnabled(projectRoot, readFileImpl) {
  let enabled = true;
  for (const file of ['.agentrc.json', '.agentrc.local.json']) {
    const value = readJsonSafe(path.join(projectRoot, file), {
      readFileSync: readFileImpl,
    })?.delivery?.quality?.gates?.crap?.enabled;
    if (typeof value === 'boolean') enabled = value;
  }
  return enabled;
}

/**
 * `project.commands.test` from `.agentrc.json` overlaid by
 * `.agentrc.local.json` — the command close's `test` gate spawns. Read without
 * `resolveConfig()` (built-ins only), like {@link isCrapEnabled}.
 *
 * @param {string} projectRoot
 * @param {typeof fs.readFileSync} readFileImpl
 * @returns {string|null} The configured command, or null when unset/default.
 */
function configuredTestCommand(projectRoot, readFileImpl) {
  let command = null;
  for (const file of ['.agentrc.json', '.agentrc.local.json']) {
    const value = readJsonSafe(path.join(projectRoot, file), {
      readFileSync: readFileImpl,
    })?.project?.commands?.test;
    if (typeof value === 'string' && value.trim().length > 0) {
      command = value.trim();
    }
  }
  return command === DEFAULT_TEST_COMMAND ? null : command;
}

/**
 * A configured `project.commands.test` is what close spawns, so the analysis
 * is of that command, never of `scripts.test`.
 *
 * @param {string} command
 * @returns {{ detail: string, remedy?: string }}
 */
function describeConfiguredTestCommand(command) {
  const lead = `\`project.commands.test\` sets close's \`test\` gate to \`${command}\``;
  if (command.includes(MANDREL_TEST_RUNNER)) {
    return {
      detail: `${lead}, which reaches mandrel's runner — a green full run on a story branch deposits the close \`test\` credit itself`,
    };
  }
  const remedy = testCreditRemedy(command);
  return {
    detail: `${lead}, which deposits no close \`test\` credit by itself — ${remedy}`,
    remedy,
  };
}

/**
 * Which depositor digest § 5 selects, stated with its exact command.
 *
 * @param {{ scripts: Record<string, string>, crapEnabled: boolean, testCommand: string|null }} probe
 * @returns {{ detail: string, remedy?: string }}
 */
function describeCreditedRun({ scripts, crapEnabled, testCommand }) {
  if (crapEnabled && scriptNamed(scripts, 'test:coverage') !== null) {
    return {
      detail: `the CRAP gate is enabled and \`test:coverage\` exists, so close registers \`coverage-capture\` and the credited run is the coverage capture: \`${COVERAGE_CAPTURE_COMMAND}\` — its fresh stamp lets close's capture skip the suite`,
    };
  }
  return testCommand !== null
    ? describeConfiguredTestCommand(testCommand)
    : describeNpmTestScript(scripts);
}

/**
 * With `project.commands.test` unset close spawns `npm test`, so the analysis
 * is of `scripts.test`.
 *
 * @param {Record<string, string>} scripts
 * @returns {{ detail: string, remedy?: string }}
 */
function describeNpmTestScript(scripts) {
  const remedy = testCreditRemedy(DEFAULT_TEST_COMMAND);
  const script = scriptNamed(scripts, 'test');
  if (script === null) {
    return {
      detail: `no \`test\` script in package.json — close still spawns \`npm test\`, so ${remedy}`,
      remedy,
    };
  }
  if (script.includes(MANDREL_TEST_RUNNER)) {
    return {
      detail: `\`npm test\` → \`${script}\` reaches mandrel's runner — a green full run on a story branch deposits the close \`test\` credit itself`,
    };
  }
  return {
    detail: `\`npm test\` → \`${script}\` is this project's own runner and never reaches \`${MANDREL_TEST_RUNNER}\`, so it deposits no close \`test\` credit and prints nothing — ${remedy}`,
    remedy,
  };
}

/**
 * Does the pre-push hook deposit gate evidence? Read, never executed.
 *
 * @param {string} projectRoot
 * @param {typeof fs.readFileSync} readFileImpl
 * @returns {{ detail: string, remedy?: string }}
 */
function describePrePushHook(projectRoot, readFileImpl) {
  let hook = null;
  let hookPath = null;
  for (const rel of [
    path.join('.husky', 'pre-push'),
    path.join('.git', 'hooks', 'pre-push'),
  ]) {
    try {
      hook = readFileImpl(path.join(projectRoot, rel), 'utf8');
      hookPath = rel.split(path.sep).join('/');
      break;
    } catch {
      // Absent here — try the next hooks location.
    }
  }
  if (hook === null) {
    return { detail: 'no pre-push hook found, so nothing runs a gate there' };
  }
  if (hook.includes('evidence-gate.js')) {
    return {
      detail: `\`${hookPath}\` routes its gates through \`evidence-gate.js\`, so the push deposits evidence close can credit`,
    };
  }
  if (HOOK_GATE_RE.test(hookCommandLines(hook))) {
    return {
      detail: `\`${hookPath}\` runs typecheck or lint without \`evidence-gate.js\`, so it deposits nothing and close re-runs them — ${PRE_PUSH_REMEDY}`,
      remedy: PRE_PUSH_REMEDY,
    };
  }
  return {
    detail: `\`${hookPath}\` runs no typecheck or lint gate, so close has nothing of it to re-run`,
  };
}

/**
 * Which credited run does digest § 5 select for this project, and does its
 * pre-push hook deposit the gate evidence close reads? Always `ok: true` —
 * every shape is supported, some just cost close a re-run — so any remedy
 * rides a passing verdict and is repeated in `detail`. Detected from files
 * only; nothing is executed.
 *
 * @param {{ projectRoot?: string, readFile?: typeof fs.readFileSync }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runTestCreditPath({
  projectRoot,
  readFile = fs.readFileSync,
} = {}) {
  const root = projectRoot ?? process.cwd();
  const parts = [
    {
      detail: `the worker's \`${STORY_HANDOFF_COMMAND}\` runs the credited run close reads`,
    },
    describeCreditedRun({
      scripts: readProjectScripts(root, readFile),
      crapEnabled: isCrapEnabled(root, readFile),
      testCommand: configuredTestCommand(root, readFile),
    }),
    describePrePushHook(root, readFile),
  ];
  const remedies = parts.map((p) => p.remedy).filter(Boolean);
  return {
    ok: true,
    detail: parts.map((p) => p.detail).join('; '),
    ...(remedies.length > 0 ? { remedy: remedies.join('; ') } : {}),
  };
}
