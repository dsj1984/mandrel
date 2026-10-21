/**
 * Claude role-agent projection: `.agents/agents/` and `.agents/local/agents/`
 * become `.claude/agents/`, payload winning a collision, with each
 * `delivery.routing.agentModels` entry overriding a role's `model:`. Node
 * built-ins only, so the doctor can import it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { applyHeader } from '../command-header.js';
import { applyAgentModel, getAgentModels } from '../config/agent-models.js';
import { readJsonOrNull } from '../json-utils.js';
import { dirExists } from '../util/paths.js';

export const CLAUDE_AGENTS_DIR = '.claude/agents';

const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/agents/ -->\n<!-- Re-run: npm run sync:agents -->\n\n';

const LOCAL_HEADER =
  '<!-- AUTO-GENERATED from .agents/local/ — do not edit. Source of truth: .agents/local/agents/ -->\n<!-- Re-run: npm run sync:agents -->\n\n';

/**
 * @param {string} dir
 * @returns {string[]}
 */
function agentFilesIn(dir) {
  if (!dirExists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
}

/**
 * `agentModels` with local merged over base per role, as `resolveConfig()`
 * would, minus AJV; invalid entries are dropped.
 *
 * @param {string} projectRoot
 * @returns {Record<string, string>}
 */
function readAgentModels(projectRoot) {
  const modelsIn = (file) =>
    readJsonOrNull(path.join(projectRoot, file))?.delivery?.routing
      ?.agentModels;
  const merged = {
    ...(modelsIn('.agentrc.json') ?? {}),
    ...(modelsIn('.agentrc.local.json') ?? {}),
  };
  return getAgentModels({ delivery: { routing: { agentModels: merged } } });
}

/**
 * Projected bytes keyed by file name.
 *
 * @param {{
 *   projectRoot: string,
 *   payloadSrc?: string,
 *   localSrc?: string,
 *   agentModels?: Record<string, string>,
 *   warn?: (line: string) => void,
 * }} opts
 * @returns {Map<string, string>}
 */
export function expectedClaudeAgents({
  projectRoot,
  payloadSrc = path.join(projectRoot, '.agents', 'agents'),
  localSrc = path.join(projectRoot, '.agents', 'local', 'agents'),
  agentModels = readAgentModels(projectRoot),
  warn = () => {},
}) {
  const expected = new Map();
  for (const [dir, header] of [
    [payloadSrc, HEADER],
    [localSrc, LOCAL_HEADER],
  ]) {
    for (const name of agentFilesIn(dir)) {
      if (expected.has(name)) {
        warn(`  shadowed  ${name} (local copy ignored; payload wins)`);
        continue;
      }
      const content = fs.readFileSync(path.join(dir, name), 'utf8');
      const model = agentModels[name.replace(/\.md$/, '')];
      expected.set(
        name,
        applyHeader(model ? applyAgentModel(content, model) : content, header),
      );
    }
  }
  return expected;
}

/**
 * @param {string} destDir
 * @returns {string[]}
 */
export function listGeneratedClaudeAgents(destDir) {
  return agentFilesIn(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();
}

/**
 * Write the projection, reap orphans, skip unchanged files.
 *
 * @param {{
 *   projectRoot: string,
 *   payloadSrc?: string,
 *   localSrc?: string,
 *   destDir?: string,
 *   agentModels?: Record<string, string>,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 * }} opts
 * @returns {{ written: string[], removed: string[], total: number }}
 */
export function syncClaudeAgents({
  projectRoot,
  payloadSrc,
  localSrc,
  destDir = path.join(projectRoot, ...CLAUDE_AGENTS_DIR.split('/')),
  agentModels,
  log = () => {},
  warn = log,
}) {
  fs.mkdirSync(destDir, { recursive: true });
  const expected = expectedClaudeAgents({
    projectRoot,
    payloadSrc,
    localSrc,
    agentModels,
    warn,
  });

  const removed = [];
  for (const name of agentFilesIn(destDir)) {
    if (expected.has(name)) continue;
    fs.unlinkSync(path.join(destDir, name));
    removed.push(name);
    log(`  removed  ${name} (no longer in .agents/agents)`);
  }

  const written = [];
  for (const [name, body] of expected) {
    const dest = path.join(destDir, name);
    let current = null;
    try {
      current = fs.readFileSync(dest, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current === body) continue;
    fs.writeFileSync(dest, body, 'utf8');
    written.push(name);
    log(`  synced   ${name}`);
  }
  return { written, removed, total: expected.size };
}
