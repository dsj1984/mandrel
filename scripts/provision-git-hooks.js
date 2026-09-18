#!/usr/bin/env node

/**
 * provision-git-hooks.js
 *
 * Materialize the repository's git hooks into a linked worktree, so commits
 * made there are subject to the same `commit-msg` / `pre-commit` / `pre-push`
 * gates as commits made in the main checkout.
 *
 * Worktrees created by `single-story-init.js` are provisioned automatically as
 * part of `worktree.bootstrap`. This entry point exists for the worktrees the
 * orchestrator never creates — a harness or hand-made `git worktree add` —
 * which are otherwise unreachable. Run it from inside such a worktree with no
 * arguments.
 */

import path from 'node:path';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  materializeGitHooks,
  resolveCommonCheckout,
} from '../.agents/scripts/lib/worktree/git-hooks.js';

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.cwd]
 * @returns {{ action: string, reason?: string, hooksPath: string|null,
 *   target: string|null, hooks: string[], worktree: string, repoRoot: string }}
 */
export function runProvisionGitHooks({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
} = {}) {
  const positional = [];
  let repoRootFlag = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo-root') {
      repoRootFlag = argv[i + 1];
      if (!repoRootFlag) {
        throw new Error('--repo-root requires a path');
      }
      i += 1;
      continue;
    }
    positional.push(argv[i]);
  }

  const worktree = path.resolve(cwd, positional[0] ?? '.');
  const repoRoot = repoRootFlag
    ? path.resolve(cwd, repoRootFlag)
    : resolveCommonCheckout(worktree);

  const result = materializeGitHooks({ repoRoot, worktree });
  return { ...result, worktree, repoRoot };
}

runAsCli(
  import.meta.url,
  async () => {
    const result = runProvisionGitHooks();
    // Compact single-line digest: this is the machine contract, and the
    // hook file list is bounded by the hooks directory itself.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  {
    source: 'provision-git-hooks',
    usage: {
      invocation:
        'node scripts/provision-git-hooks.js [<worktree-path>] [--repo-root <path>]',
      summary:
        "Materialize the repository's git hooks into a linked worktree so its commits are gated.",
      flags: [
        [
          '<worktree-path>',
          'Worktree to provision (default: the current directory).',
        ],
        [
          '--repo-root <path>',
          'Checkout that owns the hooks (default: derived from --git-common-dir).',
        ],
      ],
    },
  },
);
