/**
 * lib/orchestration/context-hydration-engine.js — Context Hydration Engine (SDK)
 *
 * Stateless, async logic for assembling the full execution prompt for an
 * agent task. Extracted from the CLI entry point to enable reuse across
 * consumers (CLI wrappers, tests).
 *
 * This module is the SDK layer — it has no knowledge of CLI arguments,
 * file I/O decisions, or process.exit(). All I/O choices are delegated
 * to the caller.
 *
 * Consumers:
 *   - `.agents/scripts/hydrate-context.js`   — the only supported CLI wrapper
 *     (imports hydrateContext; `--emit prompt` writes the raw hydrated prompt)
 *
 * @see .agents/scripts/lib/ITicketingProvider.js
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCommands } from '../config/commands.js';
import {
  getLimits,
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
} from '../config-resolver.js';

import { Logger } from '../Logger.js';
import {
  buildEnvelope,
  DEFAULT_ELIDE_POLICIES,
  DEFAULT_SECTION_PRIORITIES,
  elideEnvelope,
  envelopeToPrompt,
} from './context-envelope.js';
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
 * Resolve activated skills to Policy Capsule payloads via `skills.index.json`.
 *
 * Capsule-only is the contract (Story #3863, hard cutover): only the Policy
 * Capsule is hydrated. The full `SKILL.md` body is never inlined into a task
 * prompt — the sub-agent reads it on demand via the rendered pointer path.
 *
 * @param {object} task - Normalized task (skills[]).
 * @param {object} skillsIndex - Parsed `skills.index.json` body.
 * @returns {Array<{ skill: string, capsule: string, source: string, path: string }>}
 */
export function buildSkillCapsuleSections(task, skillsIndex) {
  const entries = [];

  for (const skill of task.skills ?? []) {
    try {
      const {
        capsule,
        source,
        path: skillPath,
      } = loadSkillCapsule(skill, skillsIndex);
      entries.push({ skill, capsule, source, path: skillPath });
    } catch (err) {
      Logger.warn(`[Hydrator] Failed to load skill ${skill}: ${err.message}`);
    }
  }

  return entries;
}

/**
 * Render skill capsule entries for the prose prompt and envelope
 * `skillCapsules` section. Each entry carries its capsule plus a pointer
 * instruction so the sub-agent knows to `Read` the full `SKILL.md` when the
 * task needs the playbook beyond the capsule's non-negotiables. The source is
 * recorded per skill for auditors.
 *
 * @param {Array<{ skill: string, capsule: string, source: string, path: string }>} entries
 * @returns {string}
 */
export function formatSkillCapsulesSection(entries) {
  if (!entries.length) return '';
  let out = '## Activated Skills\n\n';
  for (const { skill, capsule, source, path: skillPath } of entries) {
    out += `### Skill: ${skill} (source: ${source})\n${capsule}\n\n`;
    out += `Read the full playbook on demand: \`Read ${skillPath}\`.\n\n`;
  }
  return out.trimEnd();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the framework version from the installed package's `package.json`.
 *
 * Under npm distribution `package.json` is the single source of truth for the
 * framework version (the legacy plaintext version marker is retired). This
 * module ships inside the `mandrel` package at
 * `<pkgRoot>/.agents/scripts/lib/orchestration/context-hydration-engine.js`,
 * so the package manifest sits four directories up — the same layout in the
 * dev repo and in the published tarball. Read that manifest's `version`.
 *
 * Falls back to `'unknown'` when the manifest is absent or unreadable so a
 * missing package.json never crashes hydration.
 *
 * @returns {string}
 */
function getVersion() {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(moduleDir, '../../../..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Parse the work-breakdown hierarchy from a Task ticket body.
 *
 * Looks for patterns like: `Epic: #1`, `Story: #3`,
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
    result[key] = val; // e.g. { epic: 1, story: 3, prd: 4, techspec: 5 }
  }
  return result;
}

/**
 * Extract the markdown list items under a `## <heading>` section of a
 * Story body. Returns an empty array when the section is missing or has
 * no list items. Recognises both `- ` (incl. `- [ ]` / `- [x]`) and
 * `* ` bullet markers — matches the parser in `manifest-builder.js`
 * so the inline-acceptance contract round-trips verbatim across the two
 * call sites (manifest projection and context hydration).
 *
 * @param {string} body
 * @param {string} heading
 * @returns {string[]}
 */
function extractSectionList(body, heading) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const pattern = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'mi',
  );
  const startMatch = body.match(pattern);
  if (!startMatch || startMatch.index == null) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = body.slice(startIdx);
  const nextHeading = rest.search(/^##\s+/m);
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const items = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (m && m[1].length > 0) items.push(m[1].trim());
  }
  return items;
}

/**
 * Extract the inline `## Acceptance` / `## Acceptance Criteria` and
 * `## Verify` checklists from a Story body. Used by 2-tier hydration to
 * populate the `acceptanceCriteria` and `verificationCommands` envelope
 * sections directly from the dispatched Story ticket — under 2-tier the
 * Story IS the unit of execution and carries acceptance/verify inline
 * (no child tickets to walk).
 *
 * @param {string} body
 * @returns {{ acceptance: string[], verify: string[] }}
 */
export function extractStorySections(body) {
  const canonical = extractSectionList(body, 'Acceptance Criteria');
  const acceptance =
    canonical.length > 0 ? canonical : extractSectionList(body, 'Acceptance');
  const verify = extractSectionList(body, 'Verify');
  return { acceptance, verify };
}

/**
 * Detect whether the dispatched unit is a 2-tier Story (Story is the
 * leaf, carries inline acceptance/verify) vs. a 4-tier Task (Task is
 * the leaf, Story is one level up). The decision is made off the
 * `type::*` label the dispatcher already stamps on every ticket; it
 * does not depend on `planning.hierarchy`, so this engine
 * stays correct even when a 4-tier Epic ships in a 2-tier-default repo
 * (or vice versa) during the Epic #3078 dual-shape window.
 *
 * @param {object} task
 * @returns {boolean}
 */
function isTwoTierStoryTask(task) {
  const labels = task?.labels ?? [];
  return labels.includes('type::story');
}

/**
 * Load and substitute placeholders in the agent-protocol template. Extracted
 * from {@link hydrateContext} to keep its complexity manageable.
 *
 * @param {object} args
 * @param {{ templatesRoot: string }} args.paths
 * @param {object} args.settings - resolved config (post-reshape `project.*` / `delivery.*` shape)
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
// Envelope assembly helpers
// ---------------------------------------------------------------------------

/**
 * @param {object} ticket
 * @param {string} retrievedAt
 * @returns {import('./context-envelope.js').TicketSnapshot}
 */
function ticketSnapshot(ticket, retrievedAt) {
  const body = ticket.body ?? '';
  const id = ticket.id ?? ticket.number;
  const version =
    ticket.updatedAt ?? ticket.updated_at ?? ticket.updatedAtISO ?? retrievedAt;
  const hash = crypto
    .createHash('sha256')
    .update(body)
    .digest('hex')
    .slice(0, 12);
  return { id, version: String(version), hash, retrievedAt };
}

/**
 * @param {object} task
 * @returns {import('./context-envelope.js').ContextEnvelope['task']}
 */
function envelopeTaskFrom(task) {
  return {
    id: task.id,
    title: task.title,
    persona: task.persona,
    skills: task.skills,
    protocolVersion: task.protocolVersion,
  };
}

/**
 * @param {object} task
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} epicId
 * @param {object} agentSettings - Legacy-shim settings bag or resolved config.
 * @returns {Promise<{ content: string, provenance: import('./context-envelope.js').TicketSnapshot[] }>}
 */
async function buildHierarchySections(task, provider, epicId, agentSettings) {
  const hierarchyKeys = parseHierarchy(task.body);
  let hierarchyContext = '## Work Breakdown Hierarchy\n\n';
  const provenance = [];
  const retrievedAt = new Date().toISOString();

  const depth = agentSettings?.contextDepth ?? 'standard';
  const idsToFetch = [];

  if (depth === 'full') {
    idsToFetch.push({ key: 'Epic', id: epicId || hierarchyKeys.epic });
    idsToFetch.push({ key: 'PRD', id: hierarchyKeys.prd });
    idsToFetch.push({ key: 'Tech Spec', id: hierarchyKeys.techspec });
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
    .map(async (item) => {
      try {
        const t = await provider.getTicket(item.id);
        provenance.push(ticketSnapshot(t, retrievedAt));
        return `### ${item.key}: ${t.title} (#${t.id})\n\n${t.body}\n`;
      } catch (err) {
        const detail = err?.message ? `: ${err.message}` : '';
        Logger.warn(
          `[Hydrator] hierarchy fetch failed for ${item.key} #${item.id}${detail}`,
        );
        return `### ${item.key}: #${item.id} — ⚠️ unavailable (fetch failed${detail})\n`;
      }
    });

  const fetchedHierarchy = await Promise.all(fetchPromises);
  hierarchyContext += fetchedHierarchy.filter(Boolean).join('\n---\n\n');
  return { content: hierarchyContext, provenance };
}

/**
 * @param {object} task
 * @param {{ templatesRoot: string, personasRoot: string, skillsRoot: string }} paths
 * @param {object} agentSettings - Legacy-shim settings bag or resolved config.
 * @param {string} currentVersion
 * @param {string} taskBranch
 * @param {string} epicBranch
 * @returns {{ warnings: string[], sections: import('./context-envelope.js').Section[] }}
 */
function buildStaticSections(
  task,
  paths,
  agentSettings,
  currentVersion,
  taskBranch,
  epicBranch,
) {
  const warnings = [];

  if (task.protocolVersion && task.protocolVersion !== currentVersion) {
    warnings.push(
      `⚠️ WARNING: Protocol version mismatch. Task was planned with v${task.protocolVersion}, but is executing with v${currentVersion}.`,
    );
    Logger.warn(
      `[Hydrator] Protocol version mismatch on Task #${task.id}: planned with v${task.protocolVersion}, executing with v${currentVersion}`,
    );
  }

  const sections = [];
  const protocolTpl = loadProtocolTemplate({
    paths,
    settings: agentSettings,
    currentVersion,
    taskBranch,
    epicBranch,
    taskId: task.id,
  });
  if (protocolTpl) {
    sections.push({
      name: 'protocolPolicy',
      priority: DEFAULT_SECTION_PRIORITIES.protocolPolicy,
      elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.protocolPolicy,
      content: protocolTpl,
      source: { kind: 'file', ref: 'templates/agent-protocol.md' },
    });
  }

  if (task.persona) {
    try {
      const pPath = path.join(
        PROJECT_ROOT,
        paths.personasRoot,
        `${task.persona}.md`,
      );
      if (fs.existsSync(pPath)) {
        sections.push({
          name: 'persona',
          priority: DEFAULT_SECTION_PRIORITIES.persona,
          elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.persona,
          content: `## Persona: ${task.persona}\n\n${readFileCached(pPath)}`,
          source: { kind: 'file', ref: `personas/${task.persona}.md` },
        });
      }
    } catch (err) {
      Logger.warn(
        `[Hydrator] Failed to load persona ${task.persona}: ${err.message}`,
      );
    }
  }

  if (task.skills?.length > 0) {
    try {
      const skillsIndex = loadSkillsIndex();
      const entries = buildSkillCapsuleSections(task, skillsIndex);
      const skillsContext = formatSkillCapsulesSection(entries);
      if (skillsContext) {
        sections.push({
          name: 'skillCapsules',
          priority: DEFAULT_SECTION_PRIORITIES.skillCapsules,
          elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.skillCapsules,
          content: skillsContext,
          source: { kind: 'derived', ref: 'activated-skills' },
        });
      }
    } catch (err) {
      Logger.warn(`[Hydrator] Failed to load skills index: ${err.message}`);
    }
  }

  if (isTwoTierStoryTask(task)) {
    const { acceptance, verify } = extractStorySections(task.body ?? '');
    if (acceptance.length > 0) {
      sections.push({
        name: 'acceptanceCriteria',
        priority: DEFAULT_SECTION_PRIORITIES.acceptanceCriteria,
        elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.acceptanceCriteria,
        content:
          `## Acceptance Criteria (Story #${task.id})\n\n` +
          acceptance.map((item) => `- ${item}`).join('\n'),
        source: { kind: 'ticket', ref: String(task.id) },
      });
    }
    if (verify.length > 0) {
      sections.push({
        name: 'verificationCommands',
        priority: DEFAULT_SECTION_PRIORITIES.verificationCommands,
        elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.verificationCommands,
        content:
          `## Verify (Story #${task.id})\n\n` +
          verify.map((item) => `- ${item}`).join('\n'),
        source: { kind: 'ticket', ref: String(task.id) },
      });
    }
  }

  sections.push({
    name: 'taskInstructions',
    priority: DEFAULT_SECTION_PRIORITIES.taskInstructions,
    elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.taskInstructions,
    content: `## Task Instructions (Issue #${task.id}: ${task.title})\n\n${task.body}`,
    source: { kind: 'ticket', ref: String(task.id) },
  });

  return { warnings, sections };
}

// ---------------------------------------------------------------------------
// Public SDK export
// ---------------------------------------------------------------------------

/**
 * Hydrate the execution context into a {@link ContextEnvelope}.
 *
 * @param {object} task - The normalized task object from the dispatcher
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {string} epicBranch  - e.g. `epic/71`
 * @param {string} taskBranch  - e.g. `story/epic-71/my-story`
 * @param {number} epicId
 * @returns {Promise<import('./context-envelope.js').ContextEnvelope>}
 */
export async function hydrateContext(
  task,
  provider,
  epicBranch,
  taskBranch,
  epicId,
) {
  const { agentSettings } = resolveConfig();
  const maxTokens = getLimits({
    agentSettings: agentSettings ?? {},
  }).maxTokenBudget;

  const paths = getPaths({ agentSettings });
  const currentVersion = getVersion();
  const { warnings, sections: staticSections } = buildStaticSections(
    task,
    paths,
    agentSettings,
    currentVersion,
    taskBranch,
    epicBranch,
  );

  const { content: hierarchyContent, provenance } =
    await buildHierarchySections(task, provider, epicId, agentSettings);

  const sections = [...staticSections];
  const hierarchySection = {
    name: 'hierarchy',
    priority: DEFAULT_SECTION_PRIORITIES.hierarchy,
    elideWhenOverBudget: DEFAULT_ELIDE_POLICIES.hierarchy,
    content: hierarchyContent,
    source: { kind: 'derived', ref: 'work-breakdown-hierarchy' },
  };
  const taskIdx = sections.findIndex((s) => s.name === 'taskInstructions');
  if (taskIdx >= 0) {
    sections.splice(taskIdx, 0, hierarchySection);
  } else {
    sections.push(hierarchySection);
  }

  const envelope = buildEnvelope({
    task: envelopeTaskFrom(task),
    sections,
    provenance,
    warnings,
    maxTokens,
  });

  return elideEnvelope(envelope, maxTokens);
}

export { envelopeToPrompt };
