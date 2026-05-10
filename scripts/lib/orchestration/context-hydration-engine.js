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

// ---------------------------------------------------------------------------
// File-content cache — the agent-protocol template, persona files, and
// skill files are read-only during a dispatch run. Reading them via
// `fs.readFileSync` per task is ~4–16 blocking syscalls. Memoize by
// absolute path; entries survive for the lifetime of the Node process
// (fine for CLI runs; tests can call `__resetContextCache()`).
// ---------------------------------------------------------------------------

const _fileCache = new Map();

function readFileCached(absPath) {
  if (_fileCache.has(absPath)) return _fileCache.get(absPath);
  const content = fs.readFileSync(absPath, 'utf8');
  _fileCache.set(absPath, content);
  return content;
}

// ---------------------------------------------------------------------------
// Skill path index — memoized discovery for `skillsRoot`. Skill directories
// are stable for the lifetime of a dispatch run; enumerating them once keeps
// per-task hydration O(1) instead of re-probing the filesystem with
// readdirSync + existsSync on every activated skill.
// ---------------------------------------------------------------------------

let _skillIndex = null;

function buildSkillIndex(skillsRoot) {
  // Map<skillName, absoluteSkillMdPath>. First writer wins so the
  // precedence order matches the previous `candidates.find` traversal:
  //   1. skills/core/<skill>/SKILL.md
  //   2. skills/stack/<skill>/SKILL.md
  //   3. skills/<skill>/SKILL.md
  //   4. skills/stack/<category>/<skill>/SKILL.md (any subcategory)
  const index = new Map();
  const addIfMissing = (skillName, absPath) => {
    if (!index.has(skillName) && fs.existsSync(absPath)) {
      index.set(skillName, absPath);
    }
  };

  const enumerateSkillsIn = (baseDir, addFn) => {
    if (!fs.existsSync(baseDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      addFn(entry.name, path.join(baseDir, entry.name, 'SKILL.md'));
    }
  };

  enumerateSkillsIn(path.join(skillsRoot, 'core'), addIfMissing);
  enumerateSkillsIn(path.join(skillsRoot, 'stack'), addIfMissing);
  enumerateSkillsIn(skillsRoot, addIfMissing);

  // Stack subcategories: skills/stack/<category>/<skill>/SKILL.md
  const stackBase = path.join(skillsRoot, 'stack');
  if (fs.existsSync(stackBase)) {
    let categories;
    try {
      categories = fs.readdirSync(stackBase, { withFileTypes: true });
    } catch {
      categories = [];
    }
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      enumerateSkillsIn(path.join(stackBase, cat.name), addIfMissing);
    }
  }

  return index;
}

function getSkillPath(skillsRoot, skillName) {
  if (!_skillIndex || _skillIndex.root !== skillsRoot) {
    _skillIndex = { root: skillsRoot, paths: buildSkillIndex(skillsRoot) };
  }
  return _skillIndex.paths.get(skillName) ?? null;
}

/**
 * Test-only seam: clear the persona/skill/template cache between runs.
 * The `__` prefix matches the project convention for test-only exports
 * (see `git-utils.__setGitRunners`, `git-utils.__setSleep`).
 */
export function __resetContextCache() {
  _fileCache.clear();
  _skillIndex = null;
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

  // 4. Load Activated Skills
  let skillsContext = '';
  if (task.skills && task.skills.length > 0) {
    skillsContext = '## Activated Skills\n\n';
    const skillsRoot = path.join(PROJECT_ROOT, paths.skillsRoot);
    for (const skill of task.skills) {
      try {
        const sPath = getSkillPath(skillsRoot, skill);
        if (sPath) {
          skillsContext += `### Skill: ${skill}\n${readFileCached(sPath)}\n\n`;
        }
      } catch (err) {
        Logger.warn(`[Hydrator] Failed to load skill ${skill}: ${err.message}`);
      }
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
