/**
 * lib/orchestration/context-hydration-engine.js — Context Hydration Engine (SDK)
 *
 * Stateless, async logic for assembling the full execution prompt for an
 * agent task. Extracted from the CLI entry point to enable reuse across
 * consumers (CLI wrappers, MCP server, tests).
 *
 * This module is the SDK layer — it has no knowledge of CLI arguments,
 * file I/O decisions, or process.exit(). All I/O choices are delegated
 * to the caller.
 *
 * Consumers:
 *   - `.agents/scripts/context-hydrator.js`  — CLI wrapper
 *   - `lib/orchestration/dispatch-engine.js` — import hydrateContext directly
 *
 * @see .agents/scripts/lib/ITicketingProvider.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCommands } from '../config/commands.js';
import {
  getLimits,
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
} from '../config-resolver.js';

import { Logger } from '../Logger.js';
import { loadSkillCapsule } from './skill-capsule-loader.js';

// ---------------------------------------------------------------------------
// File-content cache — the agent-protocol template and persona files are
// read-only during a dispatch run. Skill bodies are loaded via
// `skills.index.json` + `loadSkillCapsule` (not cached here).
// ---------------------------------------------------------------------------

const _fileCache = new Map();

function readFileCached(absPath) {
  if (_fileCache.has(absPath)) return _fileCache.get(absPath);
  const content = fs.readFileSync(absPath, 'utf8');
  _fileCache.set(absPath, content);
  return content;
}

let _skillsIndexCache = null;

function loadSkillsIndex() {
  if (!_skillsIndexCache) {
    const indexPath = path.join(
      PROJECT_ROOT,
      '.agents',
      'skills',
      'skills.index.json',
    );
    _skillsIndexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  return _skillsIndexCache;
}

/**
 * Test-only seam: clear the persona/skill/template cache between runs.
 * The `__` prefix matches the project convention for test-only exports
 * (see `git-utils.__setGitRunners`, `git-utils.__setSleep`).
 */
export function __resetContextCache() {
  _fileCache.clear();
  _skillsIndexCache = null;
}

/**
 * Resolve activated skills to capsule payloads via `skills.index.json`.
 *
 * @param {object} task - Normalized task (skills[], labels[]).
 * @param {object} skillsIndex - Parsed `skills.index.json` body.
 * @param {{ fullSkillBodies?: boolean }} [options]
 * @returns {Array<{ skill: string, capsule: string, source: string }>}
 */
export function buildSkillCapsuleSections(task, skillsIndex, options = {}) {
  const fullBodyOptIn =
    Boolean(options.fullSkillBodies) ||
    (task.labels ?? []).includes('skill::full');
  const entries = [];

  for (const skill of task.skills ?? []) {
    try {
      const { capsule, source } = loadSkillCapsule(skill, skillsIndex, {
        fullBodyOptIn,
      });
      entries.push({ skill, capsule, source });
    } catch (err) {
      Logger.warn(
        `[Hydrator] Failed to load skill ${skill}: ${err.message}`,
      );
    }
  }

  return entries;
}

/**
 * Render skill capsule entries for the legacy prose prompt and envelope
 * `skillCapsules` section (source is recorded per skill for auditors).
 *
 * @param {Array<{ skill: string, capsule: string, source: string }>} entries
 * @returns {string}
 */
export function formatSkillCapsulesSection(entries) {
  if (!entries.length) return '';
  let out = '## Activated Skills\n\n';
  for (const { skill, capsule, source } of entries) {
    out += `### Skill: ${skill} (source: ${source})\n${capsule}\n\n`;
  }
  return out.trimEnd();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read the framework VERSION file.
 *
 * @returns {string}
 */
function getVersion() {
  try {
    return fs
      .readFileSync(path.join(PROJECT_ROOT, '.agents', 'VERSION'), 'utf8')
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Parse the work-breakdown hierarchy from a Task ticket body.
 *
 * Looks for patterns like: `Epic: #1`, `Feature: #2`, `Story: #3`,
 * `PRD: #4`, `Tech Spec: #5`.
 *
 * @param {string} body
 * @returns {Record<string, number>}
 */
export function parseHierarchy(body) {
  const result = {};
  if (!body) return result;

  const matches = [...body.matchAll(/([A-Za-z\s]+):\s*#(\d+)/gi)];
  for (const match of matches) {
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '');
    const val = Number.parseInt(match[2], 10);
    result[key] = val; // e.g. { epic: 1, feature: 2, story: 3, prd: 4, techspec: 5 }
  }
  return result;
}

/**
 * Truncate a string to fit within a rough token budget.
 * Approximation: 1 token ≈ 4 characters.
 *
 * @param {string} text
 * @param {number|undefined} tokenBudget
 * @returns {string}
 */
export function truncateToTokenBudget(text, tokenBudget) {
  if (!tokenBudget) return text;
  const maxChars = tokenBudget * 4;
  if (text.length > maxChars) {
    return (
      text.substring(0, maxChars) +
      '\n\n...[Context truncated due to token limits]...'
    );
  }
  return text;
}

/**
 * Load and substitute placeholders in the agent-protocol template. Extracted
 * from {@link hydrateContext} to keep its complexity manageable.
 *
 * @param {object} args
 * @param {{ templatesRoot: string }} args.paths
 * @param {object} args.settings - resolved agentSettings
 * @param {string} args.currentVersion
 * @param {string} args.taskBranch
 * @param {string} args.epicBranch
 * @param {string|number} args.taskId
 * @returns {string} hydrated template body, or '' on read failure
 */
function loadProtocolTemplate({
  paths,
  settings,
  currentVersion,
  taskBranch,
  epicBranch,
  taskId,
}) {
  try {
    const pTemplatePath = path.join(
      PROJECT_ROOT,
      paths.templatesRoot,
      'agent-protocol.md',
    );
    const tpl = readFileCached(pTemplatePath);
    const commands = getCommands(settings);
    const baseBranch = settings?.baseBranch ?? 'main';
    const protectedBranches = Array.isArray(settings?.git?.protectedBranches)
      ? settings.git.protectedBranches
      : [baseBranch];
    const protectedList = protectedBranches.map((b) => `\`${b}\``).join(', ');
    return tpl
      .replace(/\{\{PROTOCOL_VERSION\}\}/g, currentVersion)
      .replace(/\{\{BRANCH_NAME\}\}/g, taskBranch)
      .replace(/\{\{EPIC_BRANCH\}\}/g, epicBranch)
      .replace(/\{\{TASK_ID\}\}/g, taskId)
      .replace(/\{\{VALIDATE_CMD\}\}/g, commands.validate)
      .replace(/\{\{TEST_CMD\}\}/g, commands.test)
      .replace(/\{\{PROTECTED_BRANCHES\}\}/g, protectedList);
  } catch (err) {
    Logger.warn(`[Hydrator] Failed to load agent-protocol.md: ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public SDK export
// ---------------------------------------------------------------------------

/**
 * Hydrate the execution context into a self-contained prompt string.
 *
 * Assembles a prompt from:
 *   1. Version mismatch warning (if protocol version differs)
 *   2. Agent protocol template (`agent-protocol.md`)
 *   3. Persona document (from `.agents/personas/<persona>.md`)
 *   4. Activated skill documents (from `.agents/skills/`)
 *   5. Work-breakdown hierarchy (Epic, Feature, Story, PRD, Tech Spec bodies)
 *   6. Task instructions (from the ticket body)
 *   7. Token budget truncation (from `agentSettings.limits.maxTokenBudget`)
 *
 * @param {object} task - The normalized task object from the dispatcher
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {string} epicBranch  - e.g. `epic/71`
 * @param {string} taskBranch  - e.g. `story/epic-71/my-story`
 * @param {number} epicId
 * @returns {Promise<string>} The fully-hydrated prompt string
 */
export async function hydrateContext(
  task,
  provider,
  epicBranch,
  taskBranch,
  epicId,
) {
  const { agentSettings } = resolveConfig();
  const paths = getPaths({ agentSettings });
  const currentVersion = getVersion();
  let warnings = '';

  // 1. Version Mismatch Check
  if (task.protocolVersion && task.protocolVersion !== currentVersion) {
    warnings += `⚠️ WARNING: Protocol version mismatch. Task was planned with v${task.protocolVersion}, but is executing with v${currentVersion}.\n\n`;
    Logger.warn(
      `[Hydrator] Protocol version mismatch on Task #${task.id}: planned with v${task.protocolVersion}, executing with v${currentVersion}`,
    );
  }

  // 2. Load Agent Protocol Template
  const protocolTpl = loadProtocolTemplate({
    paths,
    settings: agentSettings,
    currentVersion,
    taskBranch,
    epicBranch,
    taskId: task.id,
  });

  // 3. Load Persona
  let personaContext = '';
  if (task.persona) {
    try {
      const pPath = path.join(
        PROJECT_ROOT,
        paths.personasRoot,
        `${task.persona}.md`,
      );
      if (fs.existsSync(pPath)) {
        personaContext = `## Persona: ${task.persona}\n\n${readFileCached(pPath)}`;
      }
    } catch (err) {
      Logger.warn(
        `[Hydrator] Failed to load persona ${task.persona}: ${err.message}`,
      );
    }
  }

  // 4. Load Activated Skills (Policy Capsule via skills.index.json)
  let skillsContext = '';
  if (task.skills && task.skills.length > 0) {
    try {
      const skillsIndex = loadSkillsIndex();
      const fullSkillBodies = Boolean(agentSettings?.hydration?.fullSkillBodies);
      const entries = buildSkillCapsuleSections(task, skillsIndex, {
        fullSkillBodies,
      });
      skillsContext = formatSkillCapsulesSection(entries);
    } catch (err) {
      Logger.warn(`[Hydrator] Failed to load skills index: ${err.message}`);
    }
  }

  // 5. Hierarchy Context Assembly
  const hierarchyKeys = parseHierarchy(task.body);
  let hierarchyContext = '## Work Breakdown Hierarchy\n\n';

  const depth = agentSettings?.contextDepth ?? 'standard';
  const idsToFetch = [];

  if (depth === 'full') {
    idsToFetch.push({ key: 'Epic', id: epicId || hierarchyKeys.epic });
    idsToFetch.push({ key: 'PRD', id: hierarchyKeys.prd });
    idsToFetch.push({ key: 'Tech Spec', id: hierarchyKeys.techspec });
    idsToFetch.push({ key: 'Feature', id: hierarchyKeys.feature });
    idsToFetch.push({ key: 'Story', id: hierarchyKeys.story });
  } else if (depth === 'standard') {
    idsToFetch.push({ key: 'Epic', id: epicId || hierarchyKeys.epic });
    idsToFetch.push({ key: 'Tech Spec', id: hierarchyKeys.techspec });
    idsToFetch.push({ key: 'Story', id: hierarchyKeys.story });
  } else if (depth === 'minimal') {
    idsToFetch.push({ key: 'Story', id: hierarchyKeys.story });
  }

  const fetchPromises = idsToFetch
    .filter((item) => item.id)
    .map((item) =>
      provider
        .getTicket(item.id)
        .then((t) => `### ${item.key}: ${t.title} (#${t.id})\n\n${t.body}\n`)
        .catch((err) => {
          // Failure-signal preservation: a silent `.catch(() => '')` here used
          // to drop hierarchy fetches (rate-limit, network, missing ticket)
          // without telling the agent the prompt was hydrated against a
          // partial context. Surface the error in the prompt + a stderr warn
          // so downstream callers (and test fixtures) can see the gap.
          const detail = err?.message ? `: ${err.message}` : '';
          Logger.warn(
            `[Hydrator] hierarchy fetch failed for ${item.key} #${item.id}${detail}`,
          );
          return `### ${item.key}: #${item.id} — ⚠️ unavailable (fetch failed${detail})\n`;
        }),
    );

  const fetchedHierarchy = await Promise.all(fetchPromises);
  hierarchyContext += fetchedHierarchy.filter(Boolean).join('\n---\n\n');

  // 6. Prompt Assembly
  const fullPromptParts = [
    warnings.trim(),
    protocolTpl,
    personaContext,
    skillsContext,
    hierarchyContext,
    `## Task Instructions (Issue #${task.id}: ${task.title})\n\n${task.body}`,
  ].filter(Boolean);

  const fullPrompt = fullPromptParts.join(
    '\n\n========================================================================\n\n',
  );

  // 7. Token Budget
  const budget = getLimits({
    agentSettings: agentSettings ?? {},
  }).maxTokenBudget;
  return truncateToTokenBudget(fullPrompt, budget);
}
