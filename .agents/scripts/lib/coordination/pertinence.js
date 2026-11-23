/**
 * The two inbox filters: whether a comment's author may speak on the channel,
 * and whether an event concerns the Story reading it.
 */

import { getChangedFiles } from '../changed-files.js';
import { parseBlockedBy } from '../dependency-parser.js';
import { createGitInterface, parseStoryBranch } from '../git-utils.js';
import { storyFootprintPaths } from '../orchestration/resolve-stories.js';
import { detectCollision } from '../wave-runner/footprint.js';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * A non-empty `trustedAuthors` replaces the association rule with a
 * case-insensitive login allowlist.
 *
 * @param {{ author_association?: string, user?: { login?: string } }} comment
 * @param {string[]} [trustedAuthors]
 * @returns {boolean}
 */
export function isTrustedComment(comment, trustedAuthors = []) {
  if (trustedAuthors.length === 0) {
    return TRUSTED_ASSOCIATIONS.has(comment?.author_association);
  }
  const login = String(comment?.user?.login ?? '').toLowerCase();
  return (
    login !== '' && trustedAuthors.some((name) => name.toLowerCase() === login)
  );
}

/**
 * The Story id of the branch checked out at `cwd`, or null.
 *
 * @param {string} cwd
 * @param {{ gitSpawn: Function }} [git]
 * @returns {number|null}
 */
export function storyIdFromBranch(cwd, git = createGitInterface({})) {
  const res = git.gitSpawn(cwd, 'branch', '--show-current');
  return res.status === 0 ? parseStoryBranch(res.stdout.trim()) : null;
}

/**
 * Paths changed against the base branch, only inside that Story's worktree.
 * Advisory: an unreadable diff adds nothing.
 *
 * @param {{ storyId: number, cwd: string, baseBranch: string, git: object }} args
 * @returns {string[]}
 */
function changedPaths({ storyId, cwd, baseBranch, git }) {
  try {
    if (storyIdFromBranch(cwd, git) !== storyId) return [];
  } catch {
    return [];
  }
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      return getChangedFiles({ ref, cwd, git });
    } catch {
      // Try the local base ref next.
    }
  }
  return [];
}

/**
 * Who is reading. `storyId: null` is the `--all` reader and makes no
 * provider call; a Story reader's footprint is its declared `changes[]` plus
 * what its worktree has changed.
 *
 * @param {{ storyId: number|null, provider: object, config?: object,
 *   cwd?: string, git?: object }} args
 * @returns {Promise<{ key: string, storyId: number|null, dependsOn: number[], footprint: string[] }>}
 */
export async function resolveReader({
  storyId,
  provider,
  config,
  cwd = process.cwd(),
  git = createGitInterface({}),
}) {
  if (storyId === null) {
    return { key: 'all', storyId, dependsOn: [], footprint: [] };
  }
  const ticket = await provider.getTicket(storyId);
  const body = ticket?.body ?? '';
  const baseBranch = config?.project?.baseBranch ?? 'main';
  return {
    key: `story-${storyId}`,
    storyId,
    dependsOn: parseBlockedBy(body),
    footprint: [
      ...new Set([
        ...storyFootprintPaths(body, storyId),
        ...changedPaths({ storyId, cwd, baseBranch, git }),
      ]),
    ],
  };
}

/**
 * A Story reader gets an event that is broadcast, names it or one of its
 * dependencies, or whose paths collide with its footprint — never its own.
 *
 * @param {{ actor: { storyId: number|null }, scope: { paths: string[], stories: number[], broadcast: boolean } }} event
 * @param {{ storyId: number|null, dependsOn: number[], footprint: string[] }} reader
 * @returns {boolean}
 */
export function isPertinent(event, reader) {
  if (reader.storyId === null) return true;
  if (event.actor.storyId === reader.storyId) return false;
  if (event.scope.broadcast) return true;
  const named = new Set([reader.storyId, ...reader.dependsOn]);
  if (event.scope.stories.some((id) => named.has(id))) return true;
  return (
    detectCollision(
      { files: event.scope.paths },
      { files: reader.footprint },
    ) !== null
  );
}
