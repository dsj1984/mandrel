#!/usr/bin/env node
/* node:coverage ignore file */
import fs from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { getRunners } from './lib/config/runners.js';
import { epicArtifactPath } from './lib/config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import { decideRefresh } from './lib/orchestration/health-refresh-cadence.js';
import { fetchTasks } from './lib/orchestration/task-fetcher.js';
import { fetchTelemetry } from './lib/orchestration/telemetry.js';
import { createProvider } from './lib/provider-factory.js';

const STATE_SCHEMA_VERSION = 1;

/**
 * Per-Epic cadence state path (Epic #1030 Story #1040 / Task #1054).
 * Migrated from `temp/health-monitor-state-<eid>.json` to
 * `temp/epic-<eid>/health-monitor-state.json` so every Epic-scoped
 * artifact lives under a single tree.
 */
function stateFilePath(epicId, projectRoot, config) {
  const rel = epicArtifactPath(epicId, 'health-monitor-state.json', config);
  return path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
}

function readState(epicId, projectRoot) {
  const file = stateFilePath(epicId, projectRoot);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== STATE_SCHEMA_VERSION) {
      return { closeCount: 0, lastRefreshAt: null, lastRefreshedWave: null };
    }
    return {
      closeCount: Number.isFinite(parsed.closeCount) ? parsed.closeCount : 0,
      lastRefreshAt: Number.isFinite(parsed.lastRefreshAt)
        ? parsed.lastRefreshAt
        : null,
      lastRefreshedWave: Number.isFinite(parsed.lastRefreshedWave)
        ? parsed.lastRefreshedWave
        : null,
    };
  } catch {
    return { closeCount: 0, lastRefreshAt: null, lastRefreshedWave: null };
  }
}

function writeState(epicId, projectRoot, state) {
  const file = stateFilePath(epicId, projectRoot);
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(
      { schemaVersion: STATE_SCHEMA_VERSION, ...state },
      null,
      2,
    );
    fs.writeFileSync(file, payload, 'utf8');
  } catch (err) {
    Logger.warn(
      `[health-monitor] Failed to persist cadence state at ${file}: ${err.message}`,
    );
  }
}

/**
 * Load the dispatch manifest from disk and resolve the wave number for the
 * given storyId. Returns null when the manifest is unavailable or the story
 * isn't listed (e.g. CLI invocation outside the post-merge pipeline, or a
 * pre-Epic-#773 manifest layout). Wave-boundary cadence falls open in that
 * case.
 */
function readStoryWaveFromManifest(epicId, storyId, projectRoot, config) {
  if (!Number.isInteger(storyId) || storyId <= 0) return null;
  // Per-Epic layout (Epic #1030 Story #1040): manifest moved from
  // `temp/dispatch-manifest-<eid>.json` to `temp/epic-<eid>/manifest.json`.
  const rel = epicArtifactPath(epicId, 'manifest.json', config);
  const manifestPath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    const stories = Array.isArray(manifest?.storyManifest)
      ? manifest.storyManifest
      : Array.isArray(manifest?.stories)
        ? manifest.stories
        : [];
    for (const s of stories) {
      const sid = Number(s.storyId ?? s.id);
      if (sid === storyId) {
        const wave = Number(s.earliestWave ?? s.wave);
        return Number.isFinite(wave) && wave >= 0 ? wave : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeOpts(opts) {
  // Preserve historical (epicId, dryRun) call signature where the second
  // argument was a boolean.
  if (typeof opts === 'boolean') return { dryRun: opts };
  return opts ?? {};
}

export async function updateHealthMetrics(epicId, optsOrDryRun = {}) {
  if (!epicId || Number.isNaN(epicId)) {
    throw new Error('updateHealthMetrics requires a valid epicId');
  }
  const opts = normalizeOpts(optsOrDryRun);
  const { dryRun = false, storyId = null, force = false } = opts;

  Logger.info(`Initializing health monitor for Epic #${epicId}...`);

  const resolved = resolveConfig();
  const { orchestration } = resolved;
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const cadenceConfig = getRunners(resolved).epicRunner.healthRefresh;

  const persistedState = readState(epicId, projectRoot);
  const currentStoryWave = readStoryWaveFromManifest(
    epicId,
    storyId,
    projectRoot,
  );
  const decision = force
    ? { refresh: true, reason: 'force=true (--no-cadence-skip)' }
    : decideRefresh(cadenceConfig, {
        ...persistedState,
        currentStoryWave,
      });

  if (!decision.refresh) {
    Logger.info(
      `[health-monitor] Skipping refresh for Epic #${epicId} — ${decision.reason}`,
    );
    writeState(epicId, projectRoot, {
      ...persistedState,
      closeCount: persistedState.closeCount + 1,
    });
    return { refreshed: false, reason: decision.reason };
  }

  Logger.info(
    `[health-monitor] Refreshing Epic #${epicId} — ${decision.reason}`,
  );

  const provider = createProvider(orchestration);

  const allEpicTickets = await provider.getTickets(epicId);
  provider.primeTicketCache(allEpicTickets);
  const healthIssue = allEpicTickets.find(
    (t) =>
      t.labels.includes(TYPE_LABELS.HEALTH) ||
      t.title.startsWith('📉 Sprint Health:'),
  );

  if (!healthIssue) {
    throw new Error(
      `No Sprint Health issue found for Epic #${epicId}. It must be created by the dispatcher first.`,
    );
  }

  const tasks = await fetchTasks(provider, epicId);

  let doneTasks = 0;
  let blockedTasks = 0;
  let inProgressTasks = 0;

  for (const task of tasks) {
    if (task.labels.includes(AGENT_LABELS.DONE)) doneTasks++;
    if (task.labels.includes(AGENT_LABELS.BLOCKED)) blockedTasks++;
    if (task.labels.includes(AGENT_LABELS.EXECUTING)) inProgressTasks++;
  }

  // Attempt to fetch friction logs using recent comments
  const { totalFriction } = await fetchTelemetry(provider, tasks);

  const progressPercent =
    tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0;

  const body = `## Real-time Sprint Health Monitoring

This issue tracks the execution metrics, progress, and friction logs for this sprint.

| Metric | Status |
|--------|--------|
| **Progress** | \`${progressPercent}%\` |
| **Tasks** | \`${doneTasks}/${tasks.length}\` |
| **Executing** | \`${inProgressTasks}\` |
| **Blocked** | \`${blockedTasks}\` |
| **Friction Events** | \`${totalFriction}\` |

_Last updated: ${new Date().toISOString()}_

---
parent: #${epicId}
Epic: #${epicId}
`;

  if (dryRun) {
    Logger.info('--- DRY RUN: Would update Health Ticket Body ---');
    console.log(body);
  } else {
    Logger.info(`Updating Health Ticket #${healthIssue.id}`);
    await provider.updateTicket(healthIssue.id, {
      body: body,
    });
    Logger.info('✅ Health issue updated successfully.');
  }

  if (!dryRun) {
    writeState(epicId, projectRoot, {
      closeCount: persistedState.closeCount + 1,
      lastRefreshAt: Date.now(),
      lastRefreshedWave: Number.isFinite(currentStoryWave)
        ? Math.max(persistedState.lastRefreshedWave ?? -1, currentStoryWave)
        : persistedState.lastRefreshedWave,
    });
  }

  return { refreshed: true, reason: decision.reason };
}

runAsCli(
  import.meta.url,
  async () => {
    const { epicId, dryRun } = parseSprintArgs();
    if (!epicId) {
      console.error('Usage: node health-monitor.js --epic <number>');
      process.exit(1);
    }
    await updateHealthMetrics(epicId, { dryRun });
  },
  { source: 'HealthMonitor' },
);
