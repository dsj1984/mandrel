// lib/cli/ui/sources.js
/**
 * What the `mandrel ui` server reads and runs, recomputed on every call:
 * the dispatch status read model joined with each in-flight Story's
 * published delivery stage, the dispatch action itself (run in process
 * through `runDispatch`), and connection presence with the accounts in use.
 * Nothing here returns or logs a credential value.
 *
 * @module cli/ui/sources
 */

import path from 'node:path';

import { runDispatch } from '../../../.agents/scripts/dispatch.js';
import { resolveConfig } from '../../../.agents/scripts/lib/config-resolver.js';
import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import { processState } from '../../../.agents/scripts/lib/dispatch/liveness.js';
import { readRecord } from '../../../.agents/scripts/lib/dispatch/record.js';
import { createProvider } from '../../../.agents/scripts/lib/provider-factory.js';
import { readJsonSafe } from '../doctor-checks/read-json.js';
import { spawn } from '../doctor-checks/spawn.js';
import { runGithubToken } from '../doctor-checks/toolchain.js';
import { createAccountProbe } from './accounts.js';
import { readStoryDetail, stageOf } from './story-detail.js';

/** Columns whose Stories are in flight and may carry a published stage. */
const IN_FLIGHT = new Set(['delivering', 'blocked']);

const ACTION_FLAGS = {
  dispatch: [],
  resume: ['--resume'],
  stop: ['--stop'],
};

/** Where an environment is defined: the local overlay, the committed file, or the implicit default. */
function definedIn(name, config, localOverlay) {
  if (localOverlay?.delivery?.environments?.[name]) {
    return '.agentrc.local.json';
  }
  return config?.delivery?.environments?.[name] ? '.agentrc.json' : 'default';
}

/** Why an environment cannot launch, or `null` when it can. */
function offlineReason(e, github, claude) {
  if (!github.ok) return 'no GitHub token';
  if (e.offlineReason) return 'cloud token not set';
  if (e.command?.[0] === 'claude' && !claude.ok) return 'claude CLI not found';
  return null;
}

/**
 * @param {{
 *   cwd?: string,
 *   env?: Record<string, string|undefined>,
 *   runner?: typeof spawn,
 *   dispatch?: typeof runDispatch,
 *   resolveConfigImpl?: typeof resolveConfig,
 *   createProviderImpl?: typeof createProvider,
 *   readJson?: (file: string) => object|null,
 *   readRecordImpl?: typeof readRecord,
 *   kill?: (pid: number, signal: 0) => void,
 *   now?: () => number,
 * }} [deps]
 */
export function createSources({
  cwd = process.cwd(),
  env = process.env,
  runner = spawn,
  dispatch = runDispatch,
  resolveConfigImpl = resolveConfig,
  createProviderImpl = createProvider,
  readJson = readJsonSafe,
  readRecordImpl = readRecord,
  kill = process.kill.bind(process),
  now = Date.now,
} = {}) {
  const config = () => resolveConfigImpl({ cwd });
  const accounts = createAccountProbe({ env, runner, now });
  const liveness = (record) => processState(record, { kill });

  async function inFlight(story, provider, resolved) {
    const stage = await stageOf(provider, story.id);
    return {
      ...story,
      stage: stage?.stage ?? null,
      stageUpdatedAt: stage?.updatedAt ?? null,
      process: liveness(readRecordImpl(story.id, { config: resolved })),
    };
  }

  async function invoke(argv, provider, resolved) {
    let out = '';
    const code = await dispatch(argv, {
      config: resolved,
      provider,
      cwd,
      write: (s) => {
        out += s;
      },
    });
    return { code, envelope: JSON.parse(out) };
  }

  async function readState() {
    const resolved = config();
    const provider = createProviderImpl(resolved);
    const { code, envelope } = await invoke(
      ['--status', '--json'],
      provider,
      resolved,
    );
    if (code !== 0) throw new Error('state-unavailable');
    const stories = await Promise.all(
      envelope.stories.map((story) =>
        IN_FLIGHT.has(story.column)
          ? inFlight(story, provider, resolved)
          : story,
      ),
    );
    const { owner, repo } = resolved?.github ?? {};
    const repository = owner && repo ? `${owner}/${repo}` : null;
    return { ...envelope, repository, stories };
  }

  /** The detail for a Story on `state`'s board, or `null` when it is not there. */
  function readStory(storyId, state) {
    const row = state.stories.find((s) => s.id === storyId);
    if (!row) return Promise.resolve(null);
    const resolved = config();
    const record = readRecordImpl(storyId, { config: resolved });
    return readStoryDetail({
      row,
      record,
      liveness: liveness(record),
      provider: createProviderImpl(resolved),
      config: resolved,
      repository: state.repository,
    });
  }

  async function runAction({ action, storyId, environment }) {
    const resolved = config();
    const argv = [...ACTION_FLAGS[action], '--env', environment, `${storyId}`];
    return invoke(argv, createProviderImpl(resolved), resolved);
  }

  async function githubPresence() {
    if (env.GITHUB_TOKEN || env.GH_TOKEN) {
      return { ok: true, source: 'environment' };
    }
    const result = await runGithubToken({ env, runner });
    return result.ok ? { ok: true, source: 'gh' } : { ok: false, source: null };
  }

  async function readConnections() {
    const resolved = config();
    const [presence, probe, account] = await Promise.all([
      githubPresence(),
      runner('claude', ['--version'], {
        shell: process.platform === 'win32',
        timeout: 10_000,
      }),
      accounts(),
    ]);
    const github = { ...presence, ...account.github };
    const claude = { ok: !probe.error && probe.status === 0 };
    const overlay = readJson(path.join(cwd, '.agentrc.local.json'));
    const environments = resolveEnvironments(resolved, env).map((e) => {
      const reason = offlineReason(e, github, claude);
      return {
        name: e.name,
        target: e.target,
        online: reason === null,
        reason,
        definedIn: definedIn(e.name, resolved, overlay),
        routine: e.routine ?? null,
      };
    });
    return {
      github,
      claude: { ...claude, account: account.claude },
      environments,
    };
  }

  return {
    readState,
    readStory,
    runAction,
    readConnections,
    environmentNames: () => resolveEnvironments(config()).map((e) => e.name),
  };
}
