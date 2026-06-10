/**
 * normalize-pr-title.js — guarantee the standalone-Story PR title is a
 * valid Conventional Commit subject so the squash-merge subject on `main`
 * parses for release-please.
 *
 * Story #3969 (framework gap). The repo squash-merges, and GitHub uses the
 * PR title as the squash-commit subject. `buildPullRequest` previously
 * emitted the raw human issue title (`<storyTitle> (#<id>)`), which is a
 * plain description ("Rename the published npm package…") that
 * release-please's Conventional-Commit parser rejects:
 *
 *   ❯ commit could not be parsed: … Rename the published npm package …
 *   ❯ error: unexpected token ' ' at 1:7, valid tokens [(, !, :]
 *   ❯ commits: 0  → no release cut
 *
 * The `commit-msg` commitlint Husky hook only validates *local* commits and
 * never runs on a GitHub-UI squash-merge title, so nothing mechanized the
 * documented "author the PR title in conventional form" contract. This
 * module mechanizes it.
 *
 * Contract (pure where possible — the only side effect is an injectable
 * `git log` read used to derive the type):
 *
 *   - If `storyTitle` is **already** a parseable Conventional Commit
 *     subject, it is preserved verbatim and suffixed with `(#<storyId>)`.
 *     No re-prefixing, no double type.
 *   - Otherwise the title is **synthesized** into conventional form:
 *     `<type>: <descriptive text> (#<storyId>)`. The `type` is derived
 *     from the branch's own (already-conventional) commit subjects when
 *     available, falling back to a safe configured default (`chore`).
 *
 * Mirrors the already-normalized Epic-finalize default in
 * `lib/orchestration/finalize/open-or-locate-pr.js` (`feat: Epic #<id>`),
 * bringing the standalone path to the same guarantee.
 */

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { Logger as DefaultLogger } from '../../../Logger.js';

/** Safe default Conventional-Commit type when none can be derived. */
export const DEFAULT_CONVENTIONAL_TYPE = 'chore';

/**
 * The Conventional-Commit types Mandrel accepts. Mirrors
 * `commitlint.config.js` → `type-enum` and `release-please-config.json` →
 * `changelog-sections`. Kept in sync by hand (single hard-cutover, no
 * shim) — adding a type means touching all three.
 */
export const CONVENTIONAL_TYPES = Object.freeze([
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'docs',
  'style',
  'chore',
  'test',
  'build',
  'ci',
]);

// Precedence used when a branch carries a mix of conventional types: pick
// the most release-significant one so the squash subject communicates the
// branch's headline impact (and release-please bumps appropriately).
const TYPE_PRECEDENCE = Object.freeze([
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'chore',
]);

const TYPE_GROUP = CONVENTIONAL_TYPES.join('|');
// Anchored Conventional-Commit header matcher:
//   <type>(<optional scope>)<optional !>: <non-empty description>
// Mirrors the shape `@commitlint/config-conventional` enforces (a known
// type, an optional parenthesised scope, an optional breaking `!`, a
// colon-space separator, and a non-empty subject). Used for the pure
// "is this already conventional?" check and to pull the type off a branch
// commit subject without spawning commitlint per call.
const CONVENTIONAL_HEADER_RE = new RegExp(
  `^(?:${TYPE_GROUP})(?:\\([^()\\r\\n]+\\))?!?: \\S.*$`,
);
const LEADING_TYPE_RE = new RegExp(
  `^(${TYPE_GROUP})(?:\\([^()\\r\\n]+\\))?!?:`,
);

/**
 * True iff `subject` is a parseable Conventional Commit subject under the
 * repo's type vocabulary. Pure.
 *
 * @param {string} subject
 * @returns {boolean}
 */
export function isConventionalSubject(subject) {
  if (typeof subject !== 'string') return false;
  return CONVENTIONAL_HEADER_RE.test(subject.trim());
}

/**
 * Extract the Conventional-Commit `type` from a single commit subject, or
 * `null` when the subject is not conventional. Pure.
 *
 * @param {string} subject
 * @returns {string|null}
 */
export function parseConventionalType(subject) {
  if (typeof subject !== 'string') return null;
  const match = subject.trim().match(LEADING_TYPE_RE);
  return match ? match[1] : null;
}

/**
 * Pick the most release-significant type from a list of conventional
 * types, honouring `TYPE_PRECEDENCE`. Returns `null` for an empty list.
 * Pure.
 *
 * @param {string[]} types
 * @returns {string|null}
 */
export function pickDominantType(types) {
  const present = new Set(types.filter(Boolean));
  for (const candidate of TYPE_PRECEDENCE) {
    if (present.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Read the branch's own commit subjects (commits unique to the Story
 * branch relative to the base branch) and derive the dominant
 * Conventional-Commit type. Returns `DEFAULT_CONVENTIONAL_TYPE` when no
 * conventional subject is found or the git read fails.
 *
 * @param {{
 *   storyBranch: string,
 *   baseBranch: string,
 *   cwd?: string,
 *   gitSpawn?: typeof defaultGitSpawn,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {string}
 */
export function deriveTypeFromBranchCommits({
  storyBranch,
  baseBranch,
  cwd = process.cwd(),
  gitSpawn = defaultGitSpawn,
  logger = DefaultLogger,
}) {
  try {
    const range = `${baseBranch}..${storyBranch}`;
    const result = gitSpawn(cwd, 'log', '--no-merges', '--format=%s', range);
    if (!result || result.status !== 0) {
      logger?.warn?.(
        `[normalize-pr-title] git log ${range} failed (status=${result?.status ?? 'n/a'}); ` +
          `defaulting type to "${DEFAULT_CONVENTIONAL_TYPE}".`,
      );
      return DEFAULT_CONVENTIONAL_TYPE;
    }
    const types = String(result.stdout ?? '')
      .split('\n')
      .map((line) => parseConventionalType(line))
      .filter(Boolean);
    return pickDominantType(types) ?? DEFAULT_CONVENTIONAL_TYPE;
  } catch (err) {
    logger?.warn?.(
      `[normalize-pr-title] could not derive type from branch commits ` +
        `(defaulting to "${DEFAULT_CONVENTIONAL_TYPE}"): ${err?.message ?? err}`,
    );
    return DEFAULT_CONVENTIONAL_TYPE;
  }
}

/**
 * Produce a PR title that parses as a Conventional Commit.
 *
 *   - Already-conventional `storyTitle` → preserved verbatim + `(#<id>)`.
 *   - Otherwise → `<derivedType>: <storyTitle> (#<id>)`.
 *   - Empty / missing `storyTitle` → `<derivedType>: Story #<id>`.
 *
 * The type derivation (`deriveTypeFromBranchCommits`) is the only side
 * effect, and is skipped entirely when the title is already conventional.
 *
 * @param {{
 *   storyTitle: string,
 *   storyId: number|string,
 *   storyBranch?: string,
 *   baseBranch?: string,
 *   cwd?: string,
 *   gitSpawn?: typeof defaultGitSpawn,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {string}
 */
export function normalizePrTitle({
  storyTitle,
  storyId,
  storyBranch,
  baseBranch,
  cwd = process.cwd(),
  gitSpawn = defaultGitSpawn,
  logger = DefaultLogger,
}) {
  const idSuffix = `(#${storyId})`;
  const trimmed = typeof storyTitle === 'string' ? storyTitle.trim() : '';

  // Already conventional → preserve verbatim, append the id reference.
  if (isConventionalSubject(trimmed)) {
    return `${trimmed} ${idSuffix}`;
  }

  // Not conventional → derive a type and synthesize.
  const type =
    storyBranch && baseBranch
      ? deriveTypeFromBranchCommits({
          storyBranch,
          baseBranch,
          cwd,
          gitSpawn,
          logger,
        })
      : DEFAULT_CONVENTIONAL_TYPE;

  // Lowercase the leading character of a synthesized description so the
  // subject satisfies commitlint's `subject-case` rule (matching the
  // `shapeMergeSubject` behaviour). An already-conventional title is left
  // untouched (it was preserved verbatim above). The empty-title fallback
  // uses a lowercased `story #<id>` for the same reason.
  const rawDescription = trimmed.length > 0 ? trimmed : `Story #${storyId}`;
  const description =
    rawDescription.charAt(0).toLowerCase() + rawDescription.slice(1);
  return `${type}: ${description} ${idSuffix}`;
}
