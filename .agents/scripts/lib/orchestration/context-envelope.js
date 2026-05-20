/**
 * context-envelope.js — typed ContextEnvelope SDK for the hydration pipeline
 * (Epic #2648, Story #2762).
 *
 * Pure functions with no I/O. Downstream Stories assemble sections from ticket
 * fetches and file reads, then serialize via {@link envelopeToPrompt}.
 *
 * @module lib/orchestration/context-envelope
 */

/** @typedef {'protocolPolicy' | 'persona' | 'skillCapsules' | 'hierarchy' | 'acceptanceCriteria' | 'verificationCommands' | 'taskInstructions'} SectionName */

/**
 * @typedef {object} SectionSource
 * @property {'file' | 'ticket' | 'derived'} kind
 * @property {string} ref
 */

/**
 * @typedef {object} Section
 * @property {SectionName} name
 * @property {number} priority Lower numbers are elided first.
 * @property {'drop' | 'summarize'} elideWhenOverBudget
 * @property {string} content
 * @property {number} estimatedTokens
 * @property {SectionSource} [source]
 */

/**
 * @typedef {object} TicketSnapshot
 * @property {number} id
 * @property {string} version ISO 8601 ticket updatedAt
 * @property {string} hash sha256(body) truncated to 12 hex chars
 * @property {string} retrievedAt ISO 8601 at fetch time
 */

/**
 * @typedef {object} ContextEnvelope
 * @property {'1'} schemaVersion
 * @property {{ id: number, title: string, persona?: string, skills?: string[], protocolVersion?: string }} task
 * @property {Section[]} sections
 * @property {TicketSnapshot[]} provenance
 * @property {{ maxTokens: number, used: number, elided: string[] }} budget
 * @property {string[]} warnings
 */

/** Separator between rendered sections — matches legacy hydrateContext join. */
export const PROMPT_SECTION_SEPARATOR =
  '\n\n========================================================================\n\n';

/** Rendering order for {@link envelopeToPrompt} (not elision priority). */
export const SECTION_RENDER_ORDER = Object.freeze([
  'protocolPolicy',
  'persona',
  'skillCapsules',
  'hierarchy',
  'acceptanceCriteria',
  'verificationCommands',
  'taskInstructions',
]);

/** Default elision priority per section name (lower drops first). */
export const DEFAULT_SECTION_PRIORITIES = Object.freeze({
  skillCapsules: 10,
  hierarchy: 20,
  acceptanceCriteria: 30,
  verificationCommands: 40,
  persona: 50,
  protocolPolicy: 80,
  taskInstructions: 100,
});

/** Default elide policy per section name. */
export const DEFAULT_ELIDE_POLICIES = Object.freeze({
  skillCapsules: 'summarize',
  hierarchy: 'summarize',
  acceptanceCriteria: 'summarize',
  verificationCommands: 'drop',
  persona: 'summarize',
  protocolPolicy: 'drop',
  taskInstructions: 'drop',
});

const SUMMARIZE_HEAD_CHARS = 200;
const TASK_INSTRUCTIONS = 'taskInstructions';

/**
 * Rough token estimate matching legacy {@link truncateToTokenBudget}.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Normalize a section: stamp estimatedTokens when absent.
 *
 * @param {Section} section
 * @returns {Section}
 */
function normalizeSection(section) {
  const content = String(section.content ?? '');
  return {
    ...section,
    content,
    estimatedTokens:
      typeof section.estimatedTokens === 'number'
        ? section.estimatedTokens
        : estimateTokens(content),
  };
}

/**
 * Sum estimatedTokens across sections.
 *
 * @param {Section[]} sections
 * @returns {number}
 */
function totalSectionTokens(sections) {
  return sections.reduce((sum, s) => sum + s.estimatedTokens, 0);
}

/**
 * Build a {@link ContextEnvelope} from assembled parts.
 *
 * @param {{
 *   task: ContextEnvelope['task'],
 *   sections: Section[],
 *   provenance?: TicketSnapshot[],
 *   warnings?: string[],
 *   maxTokens?: number,
 * }} parts
 * @returns {ContextEnvelope}
 */
export function buildEnvelope(parts) {
  const sections = (parts.sections ?? []).map(normalizeSection);
  const used = totalSectionTokens(sections);

  return {
    schemaVersion: '1',
    task: parts.task,
    sections,
    provenance: parts.provenance ?? [],
    budget: {
      maxTokens: parts.maxTokens ?? used,
      used,
      elided: [],
    },
    warnings: parts.warnings ?? [],
  };
}

/**
 * Deterministic summary for over-budget sections.
 *
 * @param {string} content
 * @returns {{ content: string, estimatedTokens: number, droppedTokens: number }}
 */
function summarizeSectionContent(content) {
  const originalTokens = estimateTokens(content);
  if (content.length <= SUMMARIZE_HEAD_CHARS) {
    return { content, estimatedTokens: originalTokens, droppedTokens: 0 };
  }
  const head = content.slice(0, SUMMARIZE_HEAD_CHARS);
  const droppedTokens = originalTokens - estimateTokens(head);
  const summary = `${head}…[elided, ${droppedTokens} tokens dropped]`;
  return {
    content: summary,
    estimatedTokens: estimateTokens(summary),
    droppedTokens,
  };
}

/**
 * Apply section-aware elision against a token budget.
 *
 * Sections iterate in ascending priority order. `taskInstructions` is never
 * dropped or summarized. When still over budget after all eligible sections
 * are elided, a warning is appended and task instructions remain intact.
 *
 * @param {ContextEnvelope} envelope
 * @param {number} maxTokens
 * @returns {ContextEnvelope}
 */
export function elideEnvelope(envelope, maxTokens) {
  const sections = envelope.sections.map((s) => ({ ...s }));
  let used = totalSectionTokens(sections);

  if (used <= maxTokens) {
    return {
      ...envelope,
      budget: { maxTokens, used, elided: [] },
    };
  }

  const elided = [];
  const byPriority = [...sections].sort((a, b) => a.priority - b.priority);

  for (const template of byPriority) {
    if (used <= maxTokens) break;
    if (template.name === TASK_INSTRUCTIONS) continue;

    const idx = sections.findIndex((s) => s.name === template.name);
    if (idx === -1) continue;

    const current = sections[idx];
    if (!current.content) continue;

    if (current.elideWhenOverBudget === 'summarize') {
      const { content, estimatedTokens } = summarizeSectionContent(
        current.content,
      );
      sections[idx] = { ...current, content, estimatedTokens };
    } else {
      sections[idx] = { ...current, content: '', estimatedTokens: 0 };
    }

    if (!elided.includes(template.name)) {
      elided.push(template.name);
    }
    used = totalSectionTokens(sections);
  }

  const warnings = [...envelope.warnings];
  if (used > maxTokens) {
    warnings.push(
      `⚠️ Context envelope still over token budget after elision (${used}/${maxTokens} tokens). Task instructions preserved intact.`,
    );
  }

  return {
    ...envelope,
    sections,
    warnings,
    budget: { maxTokens, used, elided },
  };
}

/**
 * Serialize a {@link ContextEnvelope} to the legacy prose prompt form.
 *
 * Warnings are prepended, then non-empty sections are joined in
 * {@link SECTION_RENDER_ORDER} with {@link PROMPT_SECTION_SEPARATOR}.
 * Identical envelope input yields byte-identical output.
 *
 * @param {ContextEnvelope} envelope
 * @returns {string}
 */
export function envelopeToPrompt(envelope) {
  const sectionByName = new Map(
    envelope.sections.map((section) => [section.name, section]),
  );

  const parts = [];

  const warningsText = (envelope.warnings ?? [])
    .map((w) => String(w).trim())
    .filter(Boolean)
    .join('\n\n');
  if (warningsText) {
    parts.push(warningsText);
  }

  for (const name of SECTION_RENDER_ORDER) {
    const section = sectionByName.get(name);
    if (section?.content) {
      parts.push(section.content);
    }
  }

  for (const section of envelope.sections) {
    if (!SECTION_RENDER_ORDER.includes(section.name) && section.content) {
      parts.push(section.content);
    }
  }

  return parts.join(PROMPT_SECTION_SEPARATOR);
}
