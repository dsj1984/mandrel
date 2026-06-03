/**
 * bootstrap/phased-approval — manifest-first, per-phase-group consent gate
 * for the consent-first install (Story #3524, Feature #3515, Epic #3438).
 *
 * The bootstrap CLI renders the FULL mutation manifest (every phase group,
 * including the GitHub-admin entries) before collecting a single approval,
 * then walks the four phase groups one at a time. Each group is
 * independently approvable: declining one group does NOT skip the others —
 * the walk continues to the next group regardless. The set of approved
 * phase groups is the single gate the executing pipeline honours, so the
 * preview the operator sees and the writes that land enumerate one source
 * (`buildMutationManifest`).
 *
 * This module is pure presentation + control flow over an injected
 * `confirm` primitive (default: `hitl-confirm.confirm`). It performs no
 * filesystem or network I/O of its own, so it is unit-testable without a
 * tmp tree or a live TTY.
 *
 * @module bootstrap/phased-approval
 */

import { confirm as defaultConfirm } from './hitl-confirm.js';
import { PHASE_GROUPS, previewMutationManifest } from './manifest.js';

/**
 * Stable display order for the four phase groups. The local-edit groups
 * render first (least surprising, trivially reversible), with the remote
 * GitHub-admin group last so the operator reads the irreversible mutations
 * right before the prompt that gates them.
 *
 * @type {readonly string[]}
 */
export const PHASE_GROUP_ORDER = Object.freeze([
  PHASE_GROUPS.IDE_WIRING,
  PHASE_GROUPS.REPO_CONFIG,
  PHASE_GROUPS.QUALITY_GATES,
  PHASE_GROUPS.GITHUB_ADMIN,
]);

/**
 * Human-facing one-line headers per phase group, shown above each group's
 * entry list in the manifest screen and the approval prompt.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PHASE_GROUP_LABELS = Object.freeze({
  [PHASE_GROUPS.IDE_WIRING]: 'IDE wiring (Claude Code integration)',
  [PHASE_GROUPS.REPO_CONFIG]: 'Repository config (local files)',
  [PHASE_GROUPS.QUALITY_GATES]: 'Quality gates (husky + npm scripts)',
  [PHASE_GROUPS.GITHUB_ADMIN]:
    'GitHub admin (remote, NOT trivially reversible)',
});

/**
 * Render one manifest entry as an operator-facing bullet line.
 *
 * @param {import('./manifest.js').MutationManifestEntry} entry
 * @returns {string}
 */
export function renderEntryLine(entry) {
  const flag = entry.reversible ? 'reversible' : 'IRREVERSIBLE';
  return `    - [${entry.action}] ${entry.target} — ${entry.detail} (${flag})`;
}

/**
 * Render the FULL mutation manifest as a single multi-line string, grouped
 * by phase group in {@link PHASE_GROUP_ORDER}. Only groups with at least one
 * entry appear (the `groups` map produced by `previewMutationManifest`
 * already omits empty groups). This is the first screen the operator sees —
 * the complete change list, before any approval is collected.
 *
 * Pure helper so the snapshot test can assert exact output without
 * intercepting `Logger.info` calls.
 *
 * @param {{ groups: Record<string, import('./manifest.js').MutationManifestEntry[]> }} preview
 * @returns {string}
 */
export function renderManifestScreen(preview) {
  const lines = ['', '=== Mutation Manifest (preview — no writes yet) ==='];
  for (const group of PHASE_GROUP_ORDER) {
    const entries = preview.groups[group];
    if (!entries || entries.length === 0) continue;
    lines.push(`\n  ${PHASE_GROUP_LABELS[group]} [${group}]`);
    for (const entry of entries) lines.push(renderEntryLine(entry));
  }
  return lines.join('\n');
}

/**
 * Walk the phase groups in {@link PHASE_GROUP_ORDER} and collect one
 * independent approval per non-empty group. Declining a group records it as
 * not-approved and CONTINUES to the next group — a declined group never
 * short-circuits the remaining prompts.
 *
 * Returns the structured outcome `{ approved: Set<string>, decisions: [] }`
 * so callers can both gate execution off `approved` and surface a per-group
 * decision log in the summary.
 *
 * @param {object} args
 * @param {{ groups: Record<string, import('./manifest.js').MutationManifestEntry[]> }} args.preview
 * @param {(arg: object, opts: object) => Promise<boolean>} [args.confirm]
 *   — injectable HITL confirm primitive (default `hitl-confirm.confirm`).
 * @param {'yes'|'no'} [args.assume] — forwarded to `confirm` so `--assume-yes`
 *   (or a test) can pin every group's answer without a TTY.
 * @param {NodeJS.WritableStream} [args.stdout]
 * @param {NodeJS.ReadableStream} [args.stdin]
 * @param {boolean} [args.isTTY]
 * @returns {Promise<{ approved: Set<string>,
 *   decisions: Array<{ phaseGroup: string, approved: boolean, entryCount: number }> }>}
 */
export async function collectPhaseApprovals(args) {
  const {
    preview,
    confirm = defaultConfirm,
    assume,
    stdout,
    stdin,
    isTTY,
  } = args;
  const approved = new Set();
  const decisions = [];
  for (const group of PHASE_GROUP_ORDER) {
    const entries = preview.groups[group];
    if (!entries || entries.length === 0) continue;
    const ok = await confirm(
      {
        summary: `Apply ${PHASE_GROUP_LABELS[group]} — ${entries.length} mutation(s)?`,
        current: null,
        proposed: entries,
      },
      { assume, stdout, stdin, stderr: stdout, isTTY },
    );
    if (ok) approved.add(group);
    decisions.push({
      phaseGroup: group,
      approved: ok,
      entryCount: entries.length,
    });
  }
  return { approved, decisions };
}

/**
 * Run the manifest-first phased-approval flow end-to-end: build the preview
 * from the single manifest source, render the full manifest screen, then
 * collect one approval per phase group.
 *
 * @param {object} args
 * @param {object} [args.ctx] — manifest context (`answers`, `skipGithub`,
 *   `skipQuality`); forwarded to {@link previewMutationManifest}.
 * @param {(line: string) => void} [args.log] — sink for the manifest screen
 *   (default `console.log`). Each rendered screen is emitted as one call.
 * @param {(arg: object, opts: object) => Promise<boolean>} [args.confirm]
 * @param {'yes'|'no'} [args.assume]
 * @param {NodeJS.WritableStream} [args.stdout]
 * @param {NodeJS.ReadableStream} [args.stdin]
 * @param {boolean} [args.isTTY]
 * @returns {Promise<{ preview: object, approved: Set<string>,
 *   decisions: Array<{ phaseGroup: string, approved: boolean, entryCount: number }> }>}
 */
export async function runPhasedApproval(args) {
  const { ctx = {}, log, confirm, assume, stdout, stdin, isTTY } = args;
  const preview = previewMutationManifest(ctx);
  const sink = log ?? ((line) => console.log(line));
  sink(renderManifestScreen(preview));
  const { approved, decisions } = await collectPhaseApprovals({
    preview,
    confirm,
    assume,
    stdout,
    stdin,
    isTTY,
  });
  return { preview, approved, decisions };
}
