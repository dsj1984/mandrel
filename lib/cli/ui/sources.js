// lib/cli/ui/sources.js
/**
 * What the `mandrel ui` server reads and runs, recomputed on every call:
 * the dispatch status read model joined with each in-flight Story's
 * published delivery stage, the dispatch action itself (run in process
 * through `runDispatch`), and connection presence. Nothing here returns or
 * logs a credential value.
 *
 * @module cli/ui/sources
 */

import path from 'node:path';

import { runDispatch } from '../../../.agents/scripts/dispatch.js';
import { resolveConfig } from '../../../.agents/scripts/lib/config-resolver.js';
import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import { parseDeliveryStage } from '../../../.agents/scripts/lib/orchestration/story-stage-publish.js';
import { createProvider } from '../../../.agents/scripts/lib/provider-factory.js';
import { readJsonSafe } from '../doctor-checks/read-json.js';
import { spawn } from '../doctor-checks/spawn.js';
import { runGithubToken } from '../doctor-checks/toolchain.js';

/** Columns whose Stories are in flight and may carry a published stage. */
const IN_FLIGHT = new Set(['delivering', 'blocked']);

const ACTION_FLAGS = {
  dispatch: [],
  resume: ['--resume'],
  stop: ['--stop'],
};

/** The latest published stage on a Story, or `null`; a read failure is `null`. */
async function stageOf(provider, storyId) {
  try {
    const comments = (await provider.getTicketComments(storyId)) ?? [];
    for (const comment of [...comments].reverse()) {
      const record = parseDeliveryStage(comment.body);
      if (record) return record.stage;
    }
  } catch {
    // Advisory only: a Story whose comments cannot be read shows no stage.
  }
  return null;
}

/** Where an environment is defined: the local overlay, the committed file, or the implicit default. */
function definedIn(name, config, localOverlay) {
  if (localOverlay?.delivery?.environments?.[name]) {
    return '.agentrc.local.json';
  }
  return config?.delivery?.environments?.[name] ? '.agentrc.json' : 'default';
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
} = {}) {
  const config = () => resolveConfigImpl({ cwd });

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
      envelope.stories.map(async (story) =>
        IN_FLIGHT.has(story.column)
          ? { ...story, stage: await stageOf(provider, story.id) }
          : story,
      ),
    );
    const { owner, repo } = resolved?.github ?? {};
    const repository = owner && repo ? `${owner}/${repo}` : null;
    return { ...envelope, repository, stories };
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
    const github = await githubPresence();
    const probe = await runner('claude', ['--version'], {
      shell: process.platform === 'win32',
      timeout: 10_000,
    });
    const claude = { ok: !probe.error && probe.status === 0 };
    const overlay = readJson(path.join(cwd, '.agentrc.local.json'));
    const environments = resolveEnvironments(resolved).map((e) => {
      const needsClaude = e.command[0] === 'claude';
      let reason = null;
      if (!github.ok) reason = 'no GitHub token';
      else if (needsClaude && !claude.ok) reason = 'claude CLI not found';
      return {
        name: e.name,
        target: e.target,
        online: reason === null,
        reason,
        definedIn: definedIn(e.name, resolved, overlay),
      };
    });
    return { github, claude, environments };
  }

  return {
    readState,
    runAction,
    readConnections,
    environmentNames: () => resolveEnvironments(config()).map((e) => e.name),
  };
}
