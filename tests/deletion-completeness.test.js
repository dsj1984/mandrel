/**
 * Deletion-completeness regression test (Epic #1142, Story #1158).
 *
 * 5.40.0 deleted a closed set of concepts (BookendChainer, the
 * `epic::auto-close` snapshot label, the `agent::review` epic label,
 * the `epicClose.runRetro` config knob, three `risk::*` /
 * `execution::*` labels, four config keys — `epicClose`,
 * `orchestration.hitl`, `epicRunner`, `closeRetry`, `riskGates` —
 * and three filenames: `bookend-chainer`, `epic-finalize`,
 * `epic-close`). Plus a heuristic against accessor consumers that
 * still read `.settings` from `resolveConfig()`'s return wrapper
 * (renamed to `agentSettings` in 5.40.0).
 *
 * This test ripgreps the repository's tracked, source-bearing files
 * for each concept. Allowlisted paths carry historical references
 * legitimately (CHANGELOG, ADRs, archived changelogs, plus this test
 * file's own forbidden-term list).
 *
 * A new violation fails the matching subtest with a `file:line` so
 * the offending reference is immediate. Fix by either removing the
 * reference or — for genuine historical narrative — adding the file
 * to the allowlist below with justification.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/** Files / directories whose contents are allowed to mention deleted concepts. */
const ALLOWLIST = [
  // Authoritative release narrative — the 5.40.0 entry documents every
  // deleted concept with side-by-side migration blocks.
  'docs/CHANGELOG.md',
  // Architecture Decision Records describe historical decisions and
  // explicitly name the concepts they superseded.
  'docs/decisions.md',
  // Archived changelogs (v1.0.0 – v5.29.x) preserve the original prose
  // verbatim.
  'docs/archive/',
  // Schema-mirror drift test verifies legacy keys are REJECTED — the
  // assertion has to literally name them.
  'tests/config-schema-mirror-drift.test.js',
  // Resolver-rename regression test asserts `resolved.settings` is now
  // `undefined`. The assertion legitimately reads the deleted key.
  'tests/lib/config/limits-override.test.js',
  // Mechanical baselines (CRAP, maintainability) carry historical
  // method/file paths from the v5.39.x source layout. Refreshed in
  // step with future code-renames; not human-edited.
  'baselines/',
  // This test file itself enumerates every forbidden term as plain
  // strings.
  'tests/deletion-completeness.test.js',
];

/**
 * Forbidden-term registry.
 *
 * Each entry is one ripgrep pattern. The pattern is run through `git
 * grep -nE` from the repo root, scoped to tracked files, then filtered
 * against the allowlist. Subtest titles double as failure messages.
 *
 * Discrimination notes:
 *  - `runRetro` is forbidden as a CONFIG-KEY (e.g. `runRetro: true`,
 *    `epicClose.runRetro`); it is permitted as a function identifier
 *    (`export async function runRetro`, `runRetro({ ... })`,
 *    `import { runRetro }`). The pattern targets the property-syntax
 *    forms only.
 *  - `agent::review` must not match `agent::review-spec`. The pattern
 *    uses a negative-lookahead-equivalent trailing exclusion.
 *  - `epic-close` filename must not match `epic-close-tail` (the new
 *    in-process module is `epic-deliver-close-tail.js`, not
 *    `epic-close-tail.js`, but defensive coding still rules the
 *    longer name out).
 *  - `\.settings\b` is the resolver-key heuristic. It matches
 *    `cfg.settings`, `config.settings`, `result.settings` etc. but
 *    not `agentSettings` (no preceding dot+word boundary alone).
 */
const FORBIDDEN_TERMS = [
  {
    title: '/epic-execute slash command (replaced by /epic-deliver in 5.40.0)',
    // Match the slash-command form only — not the legitimately
    // surviving CLI path `/epic-execute-record-wave.js` (the wave-
    // recording script kept its v5.39.x name in lockstep with the
    // close-tail fold; renaming it is out of scope for the SDL
    // collapse).
    pattern: '/epic-execute',
    excludeMatchSubstrings: ['epic-execute-record-wave'],
  },
  {
    title: '/epic-close slash command (replaced by /epic-deliver in 5.40.0)',
    pattern: '/epic-close',
  },
  {
    title: 'BookendChainer (autonomous-merge chainer; deleted in 5.40.0)',
    pattern: 'BookendChainer',
  },
  {
    title: 'epic::auto-close (snapshot label; deleted in 5.40.0)',
    pattern: 'epic::auto-close',
  },
  {
    title: 'agent::review (Epic-level review label; deleted in 5.40.0)',
    // Match `agent::review` but NOT `agent::review-spec`.
    pattern: 'agent::review([^-]|$)',
  },
  {
    title: 'runRetro config key (epicClose.runRetro; deleted in 5.40.0)',
    // Property-syntax only: `runRetro:` followed by `true|false|...`
    // (object literal) or `\.runRetro\b` (member access). Excludes
    // function-name uses (`function runRetro`, `import { runRetro }`,
    // `runRetro(...)`, `runRetro: <message>` error-text prefixes).
    pattern: '(\\.runRetro\\b|runRetro\\s*:\\s*(true|false|null|\\{))',
  },
  {
    title: 'risk::medium label (deleted in 5.40.0; only risk::high survives)',
    pattern: 'risk::medium',
  },
  {
    title: 'execution::sequential label (deleted in 5.40.0)',
    pattern: 'execution::sequential',
  },
  {
    title: 'execution::concurrent label (deleted in 5.40.0)',
    pattern: 'execution::concurrent',
  },
  {
    title: 'epicClose config key (agentSettings.epicClose; deleted in 5.40.0)',
    pattern: 'epicClose',
  },
  {
    title: 'orchestration.hitl placeholder block (deleted in 5.40.0)',
    pattern: 'orchestration\\.hitl',
  },
  {
    title:
      'epicRunner config key (orchestration.runners.epicRunner; renamed to deliverRunner in 5.40.0)',
    pattern: 'epicRunner',
  },
  {
    title:
      'closeRetry config key (orchestration.runners.closeRetry; renamed to storyMergeRetry in 5.40.0)',
    pattern: 'closeRetry',
  },
  {
    title:
      'riskGates config key (renamed to planning.riskHeuristics in 5.40.0)',
    pattern: 'riskGates',
  },
  {
    title: 'bookend-chainer filename (deleted in 5.40.0)',
    pattern: 'bookend-chainer',
  },
  {
    title:
      'epic-finalize filename (renamed to epic-deliver-finalize in 5.40.0)',
    pattern: 'epic-finalize',
  },
  {
    title: 'epic-close filename (deleted in 5.40.0)',
    // POSIX-grep has no negative lookahead. We match `epic-close`,
    // then post-filter out any line whose context resolves to the
    // longer compound name `epic-deliver-close-tail` (the in-process
    // close-tail module that legitimately survived the deletion).
    pattern: 'epic-close',
    excludeMatchSubstrings: ['epic-deliver-close-tail', 'epic-close-tail'],
  },
  {
    title:
      '.settings reads against resolveConfig() return (renamed to agentSettings in 5.40.0)',
    // Heuristic: `.settings` member access on identifiers that
    // commonly hold the resolver's return value. Tuned to avoid
    // false positives on local variables / `this.settings` /
    // unrelated `settings` properties — anchors on the four host
    // names the resolver's return is conventionally bound to:
    // `cfg`, `config`, `resolved`, `result`. A bare destructure of
    // `{ settings }` from a non-resolver source would not match;
    // the rename test (`tests/lib/config/limits-override.test.js`)
    // is the explicit guarantee for `resolveConfig()` shape.
    pattern: '(cfg|config|resolved|result)\\.settings\\b',
  },
];

/**
 * Run `git grep -nE -- <pattern>` against tracked files. Returns the
 * matching lines as `[ "path:line:contents", ... ]`. Empty array when
 * git-grep exits non-zero (no matches).
 */
function gitGrep(pattern) {
  try {
    const out = execFileSync('git', ['grep', '-nE', '--', pattern], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split('\n').filter((line) => line.length > 0);
  } catch (err) {
    // git-grep exit 1 == no matches; treat as empty.
    if (err.status === 1) return [];
    throw err;
  }
}

/**
 * Filter `git grep` output against the allowlist. A hit is allowed if
 * its `path/` prefix matches any allowlist entry exactly (file) or as
 * a prefix (directory).
 */
function filterAllowlist(hits) {
  return hits.filter((hit) => {
    const filePath = hit.split(':', 1)[0].replaceAll('\\', '/');
    for (const allowed of ALLOWLIST) {
      if (allowed.endsWith('/')) {
        if (filePath.startsWith(allowed)) return false;
      } else if (filePath === allowed) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Drop hits whose line content contains any of the supplied compound
 * substrings. Used for POSIX-grep patterns that need a negative-
 * lookahead-equivalent (e.g. `epic-close` matches but
 * `epic-deliver-close-tail` should not count).
 */
function filterExcludedSubstrings(hits, excludeSubstrings) {
  if (!excludeSubstrings || excludeSubstrings.length === 0) return hits;
  return hits.filter((hit) => {
    // hit format: "path:line:contents"
    const colonIdx = hit.indexOf(':', hit.indexOf(':') + 1);
    const lineContent = colonIdx >= 0 ? hit.slice(colonIdx + 1) : hit;
    for (const sub of excludeSubstrings) {
      if (lineContent.includes(sub)) return false;
    }
    return true;
  });
}

describe('deletion-completeness', () => {
  for (const { title, pattern, excludeMatchSubstrings } of FORBIDDEN_TERMS) {
    it(title, () => {
      let hits = filterAllowlist(gitGrep(pattern));
      hits = filterExcludedSubstrings(hits, excludeMatchSubstrings);
      assert.deepEqual(
        hits,
        [],
        `Forbidden 5.40.0-deleted token survived outside the allowlist:\n  pattern: /${pattern}/\n  hits:\n    ${hits.join('\n    ')}\n\nFix by removing the reference or — for genuine historical narrative — extending the allowlist in tests/deletion-completeness.test.js.`,
      );
    });
  }
});
