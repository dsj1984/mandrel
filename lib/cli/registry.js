// lib/cli/registry.js
/**
 * Ordered `mandrel doctor` check registry: each entry is `{ name, run() }`,
 * `run()` returning `{ ok, detail, remedy? }` (`remedy` present whenever
 * `ok` is false). Checks run sequentially because some presuppose an earlier
 * one (`gh-auth` needs `gh-available`). Each check lives under
 * `doctor-checks/`; this array is the order. Node built-ins only (here and in
 * every check module), so it loads inside the preflight guard before
 * third-party packages exist; no check ever echoes a token value.
 */

import { runClaudeCodeVersion } from './claude-code-version.js';
import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  readProjectDocMaxBytes,
  runCodexAgentsInSync,
  runCodexInstructions,
  runCodexSkillsInSync,
} from './doctor-checks/codex.js';
import { runMergeDriver } from './doctor-checks/merge-driver.js';
import { runAgentsDrift, runPinCurrent } from './doctor-checks/payload.js';
import {
  runAgentsMaterialized,
  runRuntimeDeps,
} from './doctor-checks/runtime-deps.js';
import { spawn } from './doctor-checks/spawn.js';
import {
  runAgentsInSync,
  runCommandsInSync,
} from './doctor-checks/sync-parity.js';
import { runTestCreditPath } from './doctor-checks/test-credit-path.js';
import {
  runGhAuth,
  runGhAvailable,
  runGitAvailable,
  runGithubToken,
  runNodeVersion,
} from './doctor-checks/toolchain.js';
import { runVersionCurrent } from './doctor-checks/version-current.js';

export {
  CODEX_PROJECT_DOC_MAX_BYTES,
  readProjectDocMaxBytes,
  runAgentsDrift,
  runCodexAgentsInSync,
  runCodexInstructions,
  runCodexSkillsInSync,
  runMergeDriver,
  runPinCurrent,
};

/** `advisory: true` marks a check whose `run()` never fails. */
export const registry = [
  {
    name: 'node-version',
    run: (opts) => runNodeVersion(opts),
  },
  {
    name: 'git-available',
    run: (opts) => runGitAvailable(opts),
  },
  {
    name: 'gh-available',
    run: (opts) => runGhAvailable(opts),
  },
  {
    name: 'github-token',
    run: (opts) => runGithubToken(opts),
  },
  // Presupposes gh-available: an absent gh binary reports there, not here.
  {
    name: 'gh-auth',
    run: (opts) => runGhAuth(opts),
  },
  {
    name: 'commands-in-sync',
    run: (opts) => runCommandsInSync(opts),
  },
  {
    name: 'agents-in-sync',
    run: (opts) => runAgentsInSync(opts),
  },
  {
    name: 'codex-skills-in-sync',
    run: (opts) => runCodexSkillsInSync(opts),
  },
  {
    name: 'codex-agents-in-sync',
    run: (opts) => runCodexAgentsInSync(opts),
  },
  {
    name: 'codex-instructions',
    run: (opts) => runCodexInstructions(opts),
  },
  {
    name: 'runtime-deps',
    run: (opts) => runRuntimeDeps(opts),
  },
  {
    name: 'agents-materialized',
    run: (opts) => runAgentsMaterialized(opts),
  },
  {
    name: 'agents-drift',
    run: (opts) => runAgentsDrift(opts),
  },
  {
    name: 'claude-code-version',
    run: (opts) =>
      runClaudeCodeVersion({
        runClaude: () => spawn('claude', ['--version'], { timeout: 10_000 }),
        ...opts,
      }),
  },
  {
    name: 'merge-driver',
    run: (opts) => runMergeDriver(opts),
  },
  {
    name: 'pin-current',
    run: (opts) => runPinCurrent(opts),
  },
  {
    name: 'version-current',
    advisory: true,
    run: (opts) => runVersionCurrent(opts),
  },
  {
    name: 'test-credit-path',
    advisory: true,
    run: (opts) => runTestCreditPath(opts),
  },
];

export default registry;
