/**
 * phases/checks.js — retro Phase 3: self-healing checks integration.
 *
 * Story #1290: invoke the self-healing checks registry with scope:'retro'
 * (read-only by construction — `runChecks` throws on autoFix:true under
 * this scope). Failures degrade gracefully to an empty findings list so
 * the retro never blocks on a probe error.
 *
 * Also owns the pure `appendChecksSection` helper that splices the
 * findings table into the composed retro body just above the
 * `<!-- retro-complete: ... -->` terminator.
 */

import { runChecks as defaultRunChecks } from '../../../checks/index.js';
import { assembleState as defaultAssembleState } from '../../../checks/state.js';

/**
 * Story #1290: invoke the self-healing checks registry with scope:'retro'
 * (read-only by construction — `runChecks` throws on autoFix:true under
 * this scope). Failures degrade gracefully to an empty findings list so
 * the retro never blocks on a probe error.
 */
export async function collectRetroFindings({
  runChecksFn = defaultRunChecks,
  assembleStateFn = defaultAssembleState,
  cwd,
  logger,
}) {
  try {
    const state = await assembleStateFn({ scope: 'retro', cwd });
    const result = await runChecksFn({
      scope: 'retro',
      autoFix: false,
      state,
    });
    return Array.isArray(result?.findings) ? result.findings : [];
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] runChecks(scope:'retro') failed (continuing with empty findings): ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Pure: append a "Self-Healing Checks" section to the retro body, listing
 * each finding's id, severity, summary, and fixCommand. When `findings` is
 * empty, the body is returned unchanged — this preserves the compact
 * "🟢 Clean sprint" shape under a clean manifest.
 *
 * The section is inserted **before** the `<!-- retro-complete: ... -->`
 * terminating marker so the marker stays at the end of the body (the
 * deliver pipeline searches for it as the EOF sentinel).
 *
 * Output format mirrors `/diagnose`'s renderTable for fixCommand display:
 * the same literal shell command appears verbatim in a fenced code block
 * so operators can copy-paste it.
 *
 * @param {string} body
 * @param {Array<import('../../../checks/index.js').Finding>} findings
 * @returns {string}
 */
export function appendChecksSection(body, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return body;
  const section = renderFindingsSection(findings);
  const markerRe = /(<!--\s*retro-complete:[^>]*-->\s*)$/;
  if (markerRe.test(body)) {
    return body.replace(markerRe, `${section}\n$1`);
  }
  return `${body}\n${section}`;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function renderFindingRow(f) {
  const id = escapeCell(f?.id);
  const severity = escapeCell(f?.severity);
  const summary = escapeCell(f?.summary);
  const fixCommand = escapeCell(f?.fixCommand);
  return `| ${id} | ${severity} | ${summary} | \`${fixCommand}\` |`;
}

function renderFindingsSection(findings) {
  return [
    '### Self-Healing Checks',
    '',
    '| ID | Severity | Summary | Fix Command |',
    '| --- | --- | --- | --- |',
    ...findings.map(renderFindingRow),
    '',
  ].join('\n');
}
