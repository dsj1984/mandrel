/**
 * normalize-pr-title.js — make the PR title (GitHub's squash subject) a
 * Conventional Commit so release-please can parse it; commitlint never sees
 * a squash title. The subject rules live in `conventional-subject.js`; this
 * module does the git read and assembles the `gh pr create` strings.
 */

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { Logger as DefaultLogger } from '../../../Logger.js';
import {
  collectBreakingNotes,
  isConventionalSubject,
  markBreaking,
  pickDominantType,
  shapeDescription,
} from './conventional-subject.js';
import { liftTrailers } from './pr-body-trailers.js';

const DEFAULT_CONVENTIONAL_TYPE = 'chore';

/** NUL cannot occur in a commit message, so a body cannot forge a split. */
const RECORD_SEP = '\u0000';

/**
 * Whole messages (bodies carry the breaking footer), oldest-first for the
 * type tie-break. Merge commits are included (a delivery trailer can sit on
 * one) unless `scope` narrows the read. A failed read returns `[]`,
 * degrading to safe defaults.
 *
 * @param {{
 *   storyBranch: string,
 *   baseBranch: string,
 *   scope?: string[],
 *   cwd?: string,
 *   gitSpawn?: typeof defaultGitSpawn,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {string[]} Whole commit messages, oldest first.
 */
function readBranchCommits({
  storyBranch,
  baseBranch,
  scope = [],
  cwd = process.cwd(),
  gitSpawn = defaultGitSpawn,
  logger = DefaultLogger,
}) {
  if (!storyBranch || !baseBranch) return [];
  const range = `${baseBranch}..${storyBranch}`;
  try {
    const result = gitSpawn(
      cwd,
      'log',
      ...scope,
      '--reverse',
      '--format=%B%x00',
      range,
    );
    if (result?.status !== 0) {
      logger?.warn?.(
        `[normalize-pr-title] git log ${range} failed (status=${result?.status ?? 'n/a'}); ` +
          `defaulting type to "${DEFAULT_CONVENTIONAL_TYPE}" and assuming no breaking change.`,
      );
      return [];
    }
    return String(result.stdout ?? '')
      .split(RECORD_SEP)
      .map((message) => message.trim())
      .filter((message) => message.length > 0);
  } catch (err) {
    logger?.warn?.(
      `[normalize-pr-title] could not read branch commits ` +
        `(defaulting to "${DEFAULT_CONVENTIONAL_TYPE}", no breaking change): ${err?.message ?? err}`,
    );
    return [];
  }
}

/** The Story's own first-parent commits: merged-in history must not pick the type. */
function readOwnCommits(read) {
  return readBranchCommits({
    ...read,
    scope: ['--first-parent', '--no-merges'],
  });
}

/**
 * A conventional title is kept verbatim; prose is synthesized as
 * `<derivedType>: <shaped title>`. Either gets `(#<id>)` and, if breaking, `!`.
 *
 * @param {{
 *   storyTitle: string,
 *   storyId: number|string,
 *   commitMessages?: string[],
 *   ownCommitMessages?: string[],
 *   storyBody?: string,
 * }} args
 * @returns {{ title: string, breaking: boolean, breakingNotes: string[] }}
 */
function normalizePrTitle({
  storyTitle,
  storyId,
  commitMessages = [],
  ownCommitMessages = commitMessages,
  storyBody = '',
}) {
  const idSuffix = `(#${storyId})`;
  const trimmed = typeof storyTitle === 'string' ? storyTitle.trim() : '';
  const { breaking, notes } = collectBreakingNotes({
    commitMessages,
    storyBody,
  });

  const subject = isConventionalSubject(trimmed)
    ? trimmed
    : synthesizeSubject({
        description: trimmed,
        storyId,
        commitMessages: ownCommitMessages,
      });

  const marked = breaking ? markBreaking(subject) : subject;
  return { title: `${marked} ${idSuffix}`, breaking, breakingNotes: notes };
}

/**
 * @param {{ description: string, storyId: number|string, commitMessages: string[] }} args
 * @returns {string}
 */
function synthesizeSubject({ description, storyId, commitMessages }) {
  const subjects = commitMessages.map((message) => message.split('\n')[0]);
  const type = pickDominantType(subjects) ?? DEFAULT_CONVENTIONAL_TYPE;
  const raw = description.length > 0 ? description : `Story #${storyId}`;
  return `${type}: ${shapeDescription(raw)}`;
}

/**
 * `Closes #<id>` auto-closes the Story; lifted trailers follow the marker and
 * a breaking footer goes LAST, per the spec, for repos that squash with the
 * PR body.
 *
 * @param {{ storyId: number|string, breakingNotes?: string[],
 *   trailerBlock?: string[] }} args
 * @returns {string}
 */
function buildPrBody({ storyId, breakingNotes, trailerBlock = [] }) {
  const lines = [
    `Closes #${storyId}`,
    '',
    '_Auto-opened by `/mandrel-deliver`._',
    ...trailerBlock,
  ];
  if (breakingNotes.length > 0) {
    lines.push('', `BREAKING CHANGE: ${breakingNotes.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * @param {string[]} breakingNotes
 * @param {(tag: string, msg: string) => void} progress
 */
function announceBreaking(breakingNotes, progress) {
  progress(
    'PR',
    '⚠️  Breaking change declared — the PR title carries `!` and the body a ' +
      `BREAKING CHANGE footer: ${breakingNotes.join(' ') || '(no note text)'}`,
  );
}

/**
 * A declared break is announced on progress so an unexpected `!` is seen
 * during the close, not in the release notes.
 *
 * @param {{ storyTitle: string, storyId: number|string, storyBody?: string,
 *   storyBranch: string, baseBranch: string, cwd?: string,
 *   gitSpawn?: typeof defaultGitSpawn, config?: object,
 *   progress?: (tag: string, msg: string) => void }} args
 * @returns {{ title: string, body: string, breaking: boolean, breakingNotes: string[] }}
 */
export function buildPullRequestFields({
  storyTitle,
  storyId,
  storyBody = '',
  storyBranch,
  baseBranch,
  cwd = process.cwd(),
  gitSpawn = defaultGitSpawn,
  config,
  progress = () => {},
}) {
  const read = { storyBranch, baseBranch, cwd, gitSpawn };
  const commitMessages = readBranchCommits(read);
  const { title, breaking, breakingNotes } = normalizePrTitle({
    storyTitle,
    storyId,
    commitMessages,
    ownCommitMessages: readOwnCommits(read),
    storyBody,
  });
  if (breaking) announceBreaking(breakingNotes, progress);
  return {
    title,
    body: buildPrBody({
      storyId,
      breakingNotes,
      trailerBlock: liftTrailers({ commitMessages, config }),
    }),
    breaking,
    breakingNotes,
  };
}
