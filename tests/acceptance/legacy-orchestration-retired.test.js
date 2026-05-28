// tests/acceptance/legacy-orchestration-retired.test.js
/**
 * AC-1..AC-5 acceptance suite — Epic #2307 ("Retire the Legacy
 * Orchestration Scripts and Migrate Checkpointer Consumers").
 *
 * Each test pins one structural invariant from the PRD (#2399) by
 * running the exact `git grep` from the Acceptance Criteria and
 * asserting zero hits in production code. AC-4 / AC-5 are encoded as
 * filesystem existence assertions because the file-presence question
 * is the AC.
 *
 * Allow-list philosophy
 * ---------------------
 * The PRD lets `tests/**` retain class/script names for resume-suite
 * fixture coverage of the new stateless stores (AC-1, AC-3 explicitly).
 * The `-- <pathspec>` arguments in each grep already scope the search
 * away from `tests/` for the rules where fixtures are permitted.
 *
 * For AC-1, prior Stories in this Epic swept the workflow / SDLC /
 * architecture documents that *invoke* the deleted scripts (Stories
 * #2425, #2440, #2437, #2438). Residual references that remain are
 * historical commentary (archived changelogs, "this code used to live
 * in X" docstrings, decisions log entries). Those references are not
 * live invocations — they describe behavior that has moved or been
 * removed. We allow-list a narrow, exhaustive set of those residual
 * comment / archive hits so a *new* live invocation introduced in
 * the future trips the test. Each allow-list entry carries a
 * justification.
 *
 * If a future contributor reintroduces an invocation of any deleted
 * script, the grep will produce a hit that falls outside the
 * allow-list and the test fails with a clear message.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Run `git grep` with the supplied args from REPO_ROOT and return the
 * line array (empty when no hits — `git grep` exits 1 on no-match).
 *
 * The wrapper normalizes the no-match exit code into an empty result
 * and re-throws on other non-zero exits so a broken invocation isn't
 * silently treated as "clean".
 */
function gitGrep(args) {
  try {
    const out = execFileSync('git', ['grep', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0);
  } catch (err) {
    // git grep exits 1 when there are no matches — that's the success
    // case for these tests, so coerce to an empty array.
    if (err.status === 1 && (err.stderr ?? '').toString().trim() === '') {
      return [];
    }
    throw err;
  }
}

/**
 * AC-1 allow-list — explicit, justified residual references that are
 * NOT live invocations of the deleted scripts. A future contributor
 * adding a real `node .agents/scripts/epic-deliver-finalize.js` call
 * (or equivalent) will produce a hit that fails to match any allow-
 * list entry, failing the test.
 *
 * Format: { file, marker } — `marker` is a stable substring inside
 * the matching line. Matching is "file ends-with AND line contains
 * marker" so the allow-list survives line-number drift.
 */
const AC1_ALLOWED_RESIDUAL = [
  // Historical changelog mention of the webhook fire-point — accurate
  // as of the v6.x cutover, retained for release notes.
  {
    file: 'docs/CHANGELOG.md',
    marker: '`epic-complete` webhook',
  },
  // Archived pre-v6 changelog snapshot. The archive directory is
  // immutable history and must keep its references intact.
  {
    file: 'docs/archive/CHANGELOG-pre-v6.md',
    marker: 'epic-deliver-finalize.js',
  },
  // Operator decisions log — documents the rename history
  // (epic-finalize.js → epic-deliver-finalize.js) as a permanent
  // operator-visible audit trail.
  {
    file: 'docs/decisions.md',
    marker: 'epic-deliver-finalize.js',
  },
  // /epic-plan workflow comment describing planning-ticket auto-close
  // behavior. Refers to the historical close point; not an invocation.
  {
    file: '.agents/workflows/epic-plan.md',
    marker: 'closed automatically by',
  },
  // The following entries are inline JSDoc/comment references inside
  // production .js files that describe historic ownership ("this used
  // to live in X") or document the lifecycle event's prior emit point.
  // They are NOT runtime invocations — they do not call the deleted
  // scripts. Sweeping them is tracked as documentation hygiene; the
  // pin here is "no NEW live invocations".
  {
    file: '.agents/scripts/acceptance-spec-reconciler.js',
    marker: 'Used by `epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/check-lifecycle-lint.js',
    marker: 'in `epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/check-lifecycle-lint.js',
    marker: 'epic-deliver-automerge.js',
  },
  {
    file: '.agents/scripts/epic-close.js',
    marker: '@see .agents/scripts/epic-deliver-finalize.js',
  },
  {
    file: '.agents/scripts/epic-plan-decompose.js',
    marker: '`epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/lib/epic-close-tail-helpers.js',
    marker: 'epic-deliver-finalize.js',
  },
  {
    file: '.agents/scripts/lib/issue-link-parser.js',
    marker: 'epic-deliver-finalize.js',
  },
  {
    file: '.agents/scripts/lib/orchestration/epic-runner/hotspot-detection.js',
    marker: '`epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/lib/orchestration/epic-runner/progress-reporter/transport.js',
    marker: 'single emit point is now `epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js',
    marker: '`epic-deliver-finalize.js` shim',
  },
  {
    file: '.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js',
    marker: 'epic-deliver-automerge.js',
  },
  {
    file: '.agents/scripts/lib/orchestration/ticketing/bulk.js',
    marker: 'epic-deliver-finalize.js',
  },
  {
    file: '.agents/scripts/lib/orchestration/wave-record-notifications.js',
    marker: 'epic-deliver-finalize.js',
  },
  // lifecycle-emit.js literally documents itself as the replacement
  // for the three deleted shim scripts. Naming them is intentional.
  {
    file: '.agents/scripts/lifecycle-emit.js',
    marker: '`epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/lifecycle-emit.js',
    marker: '`epic-deliver-cleanup.js`',
  },
  // single-story-close.js documents its mirroring of the
  // epic-deliver-finalize pattern — descriptive prose, not a call.
  {
    file: '.agents/scripts/single-story-close.js',
    marker: 'Mirrors `epic-deliver-finalize.js`',
  },
  {
    file: '.agents/scripts/single-story-close.js',
    marker: '`epic-deliver-finalize.js`: squash strategy',
  },
];

/**
 * A `git grep` line has the shape "<path>:<content>". Return true when
 * the line matches at least one allow-list entry (file path suffix +
 * stable content marker).
 */
function isAllowListed(line, allowList) {
  // Split only on the first colon — paths never contain ':' in this
  // repo's hits.
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return false;
  // Normalize to forward slashes so the same allow-list works on
  // Windows and POSIX runners.
  const file = line.slice(0, colonIdx).replace(/\\/g, '/');
  const content = line.slice(colonIdx + 1);
  return allowList.some(
    (entry) => file === entry.file && content.includes(entry.marker),
  );
}

describe('Epic #2307 — Acceptance Criteria 1..5 (deletion-grep invariants)', () => {
  it('AC-1: no live invocations of the three retired epic-deliver-*.js shim scripts', () => {
    // Tech Spec lock-in: scripts retired in Stories #2432 / #2442.
    // The replacement entry point is .agents/scripts/lifecycle-emit.js.
    const hits = gitGrep([
      '-E',
      'epic-deliver-(finalize|automerge|cleanup)\\.js',
      '--',
      '.agents',
      'docs',
      '.github',
    ]);
    const violations = hits.filter(
      (line) => !isAllowListed(line, AC1_ALLOWED_RESIDUAL),
    );
    assert.deepEqual(
      violations,
      [],
      [
        'AC-1 regression: at least one new reference to a retired',
        'epic-deliver-*.js shim slipped past the allow-list.',
        'Either remove the reference or, if the reference is a',
        'documentation-only addition that should be permanent,',
        'extend AC1_ALLOWED_RESIDUAL with a justification.',
        '',
        'Unallowed hits:',
        ...violations,
      ].join('\n'),
    );
  });

  it('AC-2: no production imports of the deleted Checkpointer / legacy-resume / legacy automerge modules', () => {
    // Tech Spec lock-in: every consumer of these modules was migrated
    // to the stateless stores or the lifecycle listener export site
    // before the modules were deleted (Stories #2406, #2408, #2409,
    // #2413, #2414, #2415).
    const hits = gitGrep([
      '-E',
      'from .*epic-runner/checkpointer|from .*lifecycle/legacy-resume|from .*lib/orchestration/automerge-predicate',
      '--',
      '.agents',
    ]);
    assert.deepEqual(
      hits,
      [],
      [
        'AC-2 regression: a production-code import names one of the',
        'deleted legacy orchestration modules. Repoint the import at',
        'epic-run-state-store.js, epic-plan-state-store.js, or the',
        'inlined evaluator inside',
        '.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js.',
        '',
        'Offending imports:',
        ...hits,
      ].join('\n'),
    );
  });

  it('AC-3: no Checkpointer class references in production code (tests/ allow-listed for fixture coverage)', () => {
    // Tech Spec lock-in: the Checkpointer + PlanCheckpointer classes
    // were deleted in Story #2423 / Task #2433 after every production
    // consumer migrated to epic-run-state-store / epic-plan-state-store.
    // The resume-suite tests intentionally keep `new Checkpointer(...)`
    // patterns through a fixture adapter (#2435) — that's why the grep
    // scopes to .agents/ only.
    const hits = gitGrep([
      '-E',
      'Checkpointer\\.|new Checkpointer\\(',
      '--',
      '.agents',
    ]);
    assert.deepEqual(
      hits,
      [],
      [
        'AC-3 regression: production code under .agents/ references the',
        'deleted Checkpointer class. Migrate to the stateless store',
        '(epic-run-state-store.js for runtime state,',
        'epic-plan-state-store.js for planning state).',
        '',
        'Offending references:',
        ...hits,
      ].join('\n'),
    );
  });

  it('AC-4: the legacy lib/orchestration/automerge-predicate.js module is deleted', () => {
    // Tech Spec lock-in: evaluator body was inlined into the lifecycle
    // listener (Story #2415); the legacy module file was deleted in
    // that same Story. The listener at
    // lifecycle/listeners/automerge-predicate.js is a different file
    // and remains the canonical home for the evaluator.
    const legacyPath = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'automerge-predicate.js',
    );
    assert.equal(
      existsSync(legacyPath),
      false,
      [
        'AC-4 regression: .agents/scripts/lib/orchestration/automerge-predicate.js',
        'reappeared. Its body now lives in',
        '.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js;',
        'the standalone legacy module must stay deleted.',
      ].join('\n'),
    );
  });

  it('AC-5: the legacy lib/orchestration/lifecycle/legacy-resume.js module is deleted', () => {
    // Tech Spec lock-in: the one-shot pre-cutover NDJSON seeder was
    // retired in Story #2414 / Task #2427. Its call site inside the
    // checkpoint-pointer-writer listener was removed in the same
    // Story.
    const legacyPath = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'lifecycle',
      'legacy-resume.js',
    );
    assert.equal(
      existsSync(legacyPath),
      false,
      [
        'AC-5 regression: .agents/scripts/lib/orchestration/lifecycle/legacy-resume.js',
        'reappeared. D-1 already ran against every live Epic, so the',
        'one-shot seeder is permanently unnecessary and must stay',
        'deleted.',
      ].join('\n'),
    );
  });
});
