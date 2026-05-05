/**
 * Task body renderer.
 *
 * Pure functions that turn a structured task body into the canonical markdown
 * shape the orchestrator and downstream agents both consume. Server-side
 * rendering keeps the LLM spending tokens on substance (the four-section
 * payload), while keeping the orchestrator footer (`parent: #<n>` /
 * `Epic: #<m>` / `blocked by #<x>`) byte-stable so existing consumers that
 * parse it (manifest, close-gate, dispatcher) continue to work unchanged.
 *
 * The structured body shape (see `decomposer-prompts.js`):
 *   {
 *     goal:       string,           // one sentence, names the parent Story slug
 *     changes:    string[],         // "<file path>: <verb> <object>" bullets
 *     acceptance: string[],         // observable, testable criteria
 *     verify:     string[],         // "<command or test path> (<tier>)" or "manual:<reason>"
 *   }
 */

/**
 * Render the four-section body markdown. Does NOT include the orchestrator
 * footer; pair with `renderOrchestratorFooter` via `composeTaskBody`.
 *
 * @param {{goal: string, changes: string[], acceptance: string[], verify: string[]}} body
 * @returns {string}
 */
export function renderTaskBody(body) {
  const goal = (body?.goal ?? '').trim();
  const changes = (body?.changes ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const acceptance = (body?.acceptance ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const verify = (body?.verify ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);

  const sections = [
    '## Goal',
    goal,
    '',
    '## Changes',
    ...changes.map((c) => `- ${c}`),
    '',
    '## Acceptance',
    ...acceptance.map((c) => `- [ ] ${c}`),
    '',
    '## Verify',
    ...verify.map((v) => `- ${v}`),
  ];
  return sections.join('\n');
}

/**
 * Render the orchestrator footer. The leading `---\n` separator is included.
 * Format MUST match the existing string-body footer byte-for-byte for
 * `parent: #<n>` / `Epic: #<m>` / `blocked by #<x>`; `audit-snapshot:` is
 * additive and slots in BEFORE the dependency block so consumers parsing
 * the latter (story-init, dispatcher) keep their existing line-anchored
 * regex semantics.
 *
 * @param {{parentId: number, epicId?: number, dependencies?: number[], auditSnapshot?: string}} opts
 * @returns {string}
 */
export function renderOrchestratorFooter({
  parentId,
  epicId,
  dependencies = [],
  auditSnapshot,
}) {
  const lines = ['---', `parent: #${parentId}`];
  if (epicId !== undefined && epicId !== null && epicId !== parentId) {
    lines.push(`Epic: #${epicId}`);
  }
  if (auditSnapshot) {
    lines.push(`audit-snapshot: ${auditSnapshot}`);
  }
  if (dependencies.length > 0) {
    lines.push('');
    for (const dep of dependencies) {
      lines.push(`blocked by #${dep}`);
    }
  }
  return lines.join('\n');
}

/**
 * Compose the final markdown body. `body` may be a string (legacy
 * Feature/Story shape — pass-through) or a structured task body object.
 *
 * @param {{
 *   body: string | object,
 *   parentId: number,
 *   epicId?: number,
 *   dependencies?: number[],
 *   auditSnapshot?: string,
 * }} opts
 * @returns {string}
 */
export function composeTaskBody({
  body,
  parentId,
  epicId,
  dependencies = [],
  auditSnapshot,
}) {
  const isStructured = body !== null && typeof body === 'object';
  const head = isStructured ? renderTaskBody(body) : body || '';
  const footer = renderOrchestratorFooter({
    parentId,
    epicId,
    dependencies,
    auditSnapshot: isStructured ? auditSnapshot : undefined,
  });
  return `${head}\n\n${footer}`;
}

/**
 * True when the markdown body already starts with the four-section header.
 * Used by the retrofit utility for idempotency — already-conforming tasks
 * are skipped.
 */
export function hasStructuredHeader(markdownBody) {
  return /^## Goal\n/.test((markdownBody ?? '').trimStart());
}
