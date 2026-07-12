/**
 * phases/close-validation.js — run the canonical close-validation gate
 * chain for a standalone Story.
 *
 * The standalone path uses the same `runCloseValidation` chain as
 * Epic-attached Stories so the experience matches — only the baseline
 * ref changes (`main`, not `epic/<id>`).
 *
 * Standalone evidence keyspace (Story #4250). Standalone Stories have no
 * parent Epic, so they cannot scope a `validation-evidence.json` under a
 * `temp/epic-<id>/` tree. Rather than feed a null `epicId` into the
 * Epic-keyed path (which structurally disabled the evidence cache and
 * forced every re-run — base-sync conflict, review remediation, baseline
 * absorb — to re-execute ALL gates including the coverage suite), the
 * standalone close now passes `standalone: true`. `runCloseValidation`
 * then anchors the cache on the Story id alone at
 * `temp/standalone/stories/story-<id>/validation-evidence.json`, so a
 * second close at unchanged HEAD short-circuits the already-passed gates.
 *
 * Format-autofix self-heal (Story #4250). The Epic path runs
 * `runScopedFormatAutofix` before the check-only gates so benign JSON/YAML
 * drift the formatter can fix is folded into a `fix(story-close):` commit
 * rather than hard-failing the format gate. The standalone path now does
 * the same, with `baseBranch` as the diff anchor and the Story worktree as
 * the commit target.
 *
 * `runCloseValidation`, `buildDefaultGates`, and `runScopedFormatAutofix`
 * are accepted as injected dependencies so the parent CLI's cache-busted
 * bindings win in tests that mock the upstream module URLs.
 */

import { buildDefaultGates as defaultBuildDefaultGates } from '../../../close-validation/gates.js';
import { runCloseValidation as defaultRunCloseValidation } from '../../../close-validation/runner.js';
import { Logger } from '../../../Logger.js';
import { runScopedFormatAutofix as defaultRunScopedFormatAutofix } from '../../story-close/format-autofix.js';

/**
 * Run the close-validation gate chain. Throws on first gate failure.
 *
 * Order (Story #4250): format-autofix self-heal → close-validation gates.
 * The autofix step scopes the formatter to the `baseBranch...storyBranch`
 * diff, commits any fix on the Story branch inside the Story worktree, and
 * is best-effort — a missing `storyBranch` (resume/legacy callers) skips it
 * with a log line rather than failing.
 *
 * Gates are built from the canonical resolved config (`buildDefaultGates`
 * reads `project.commands` and `delivery.quality.gates.crap.enabled`); the
 * `baseBranch` is forwarded as the gate `epicBranch` so the format gate's
 * changed-file scope anchors on it. `standalone: true` routes the evidence
 * cache to the storyId-anchored keyspace.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   config: object,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   storyId: number,
 *   progress: (tag: string, msg: string) => void,
 *   runCloseValidation?: typeof defaultRunCloseValidation,
 *   buildDefaultGates?: typeof defaultBuildDefaultGates,
 *   runScopedFormatAutofix?: typeof defaultRunScopedFormatAutofix,
 * }} args
 */
export async function runCloseValidationPhase({
  cwd,
  worktreePath,
  config,
  baseBranch,
  storyBranch,
  storyId,
  progress,
  runCloseValidation = defaultRunCloseValidation,
  buildDefaultGates = defaultBuildDefaultGates,
  runScopedFormatAutofix = defaultRunScopedFormatAutofix,
}) {
  // Story #4250 — format-autofix self-heal before the check-only gates.
  // Mirrors the Epic path (story-close/phases/gates.js): the formatter is
  // scoped to the baseBranch...storyBranch diff, and any fix is committed on
  // the Story branch in the Story worktree. Skipped (with a log) when no
  // storyBranch is available so resume/legacy callers don't trip a throw.
  if (storyBranch) {
    progress(
      'FORMAT',
      `Running scoped format-autofix on ${baseBranch}...${storyBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
    );
    // Best-effort self-heal: a failure to even compute the diff (e.g. a
    // missing ref) must never abort close — the format check gate downstream
    // is the source of truth for "is the tree formatted". We log and proceed.
    try {
      const autofix = runScopedFormatAutofix({
        cwd,
        worktreePath,
        storyId,
        epicBranch: baseBranch,
        storyBranch,
        config,
        logger: Logger,
      });
      if (autofix?.committed) {
        progress(
          'FORMAT',
          `✅ Auto-applied format fix committed as ${autofix.sha} on ${storyBranch}.`,
        );
      } else {
        progress(
          'FORMAT',
          `⏭ No format-autofix commit (${autofix?.reason ?? 'clean'}).`,
        );
      }
    } catch (err) {
      progress(
        'FORMAT',
        `⚠️ scoped format-autofix failed (close continues; format gate is authoritative): ${err?.message ?? err}`,
      );
    }
  } else {
    progress('FORMAT', '⏭ Skipped scoped format-autofix (no story branch).');
  }

  progress(
    'VALIDATE',
    `Running close-validation gates against baseline ${baseBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
  const validation = await runCloseValidation({
    cwd,
    worktreePath,
    gates: buildDefaultGates({
      config,
      epicBranch: baseBranch,
      cwd: worktreePath || cwd,
    }),
    log: (m) => Logger.info(m),
    storyId,
    // Story #4250 — standalone storyId-anchored evidence keyspace. No
    // epicId; the standalone flag routes the cache to
    // temp/standalone/stories/story-<id>/validation-evidence.json.
    standalone: true,
  });
  if (!validation.ok) {
    const [first] = validation.failed;
    const { gate, status, cwd: gateCwd } = first;
    throw new Error(
      `[single-story-close] Gate failed: ${gate.name} (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
        (gate.hint ? ` ${gate.hint}` : ''),
    );
  }
  progress('VALIDATE', '✅ All gates passed.');
}
