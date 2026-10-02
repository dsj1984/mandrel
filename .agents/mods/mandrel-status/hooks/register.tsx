// mandrel-status — a beta, read-only Claude Code mod. It reads the state files
// /mandrel-deliver already writes and draws one line above the prompt. Nothing
// in Mandrel depends on it; see .agents/docs/runbooks/mods.md.

import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';

import type { InFlight, LastResult, Snapshot } from '../types';

const REFRESH_MS = 15_000;
const STALL_MS = 10 * 60_000;
const RECENT_MS = 2 * 60 * 60_000;
const WORKTREE = /^story-(\d+)$/;
const ENVELOPE = /^story-deliver-terminal-(\d+)\.json$/;
const GATE_LOG = /^close-gates-(\d+)\.log$/;
const ANNOUNCED = new Set(['landed', 'blocked']);

const EMPTY: Snapshot = { inFlight: null, last: null };
const snapshot = atom(
  { plugin: 'mandrel-status', key: 'snapshot' } as const,
  EMPTY,
);
const seen = atom(
  { plugin: 'mandrel-status', key: 'seen' } as const,
  [] as string[],
);
const isSeeded = atom(
  { plugin: 'mandrel-status', key: 'isSeeded' } as const,
  false,
);

type Stamped = { storyId: number; mtimeMs: number };

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path));
  } catch {
    return undefined;
  }
}

function tempRootOf(config: unknown): string | undefined {
  const value = (config as { project?: { paths?: { tempRoot?: unknown } } })
    ?.project?.paths?.tempRoot;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `.agentrc.local.json` wins over `.agentrc.json`; `temp` when neither sets it. */
async function resolveTempRoot($: EngineInterface): Promise<string> {
  return (
    tempRootOf(await readJson($, '.agentrc.local.json')) ??
    tempRootOf(await readJson($, '.agentrc.json')) ??
    'temp'
  );
}

async function listMatching(
  $: EngineInterface,
  dir: string,
  pattern: RegExp,
  kind: 'file' | 'dir',
): Promise<Stamped[]> {
  const entries = await $.fs.list(dir).catch(() => []);
  const found: Stamped[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (!match || entry.kind !== kind) continue;
    const mtimeMs =
      kind === 'file'
        ? entry.mtimeMs
        : await $.fs
            .stat(`${dir}/${entry.name}`)
            .then((stat) => stat.mtimeMs)
            .catch(() => 0);
    found.push({ storyId: Number(match[1]), mtimeMs });
  }
  return found;
}

const newest = (list: Stamped[]): Stamped | undefined =>
  [...list].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

function pickInFlight(
  worktrees: Stamped[],
  envelopes: Stamped[],
  gateLogs: Stamped[],
  now: number,
): InFlight | null {
  const open = worktrees.filter((tree) => {
    const envelope = envelopes.find((one) => one.storyId === tree.storyId);
    return !envelope || envelope.mtimeMs < tree.mtimeMs;
  });
  const story = newest(open);
  if (!story) return null;
  const log = gateLogs.find((one) => one.storyId === story.storyId);
  const idleMs = log ? now - log.mtimeMs : 0;
  return {
    storyId: story.storyId,
    isClosing: Boolean(log),
    stalledMinutes: idleMs > STALL_MS ? Math.floor(idleMs / 60_000) : null,
  };
}

function toLastResult(storyId: number, raw: unknown): LastResult | null {
  const envelope = raw as {
    status?: unknown;
    elapsedSeconds?: unknown;
    pr?: { number?: unknown; checksStatus?: unknown } | null;
  };
  if (typeof envelope?.status !== 'string') return null;
  const pr = envelope.pr ?? {};
  return {
    storyId,
    status: envelope.status,
    prNumber: typeof pr.number === 'number' ? pr.number : null,
    checksStatus: typeof pr.checksStatus === 'string' ? pr.checksStatus : null,
    elapsedSeconds:
      typeof envelope.elapsedSeconds === 'number'
        ? envelope.elapsedSeconds
        : null,
  };
}

async function scan(
  $: EngineInterface,
): Promise<{ next: Snapshot; latest?: Stamped }> {
  if (!(await $.fs.exists('.agents').catch(() => false)))
    return { next: EMPTY };
  const orchestration = `${await resolveTempRoot($)}/orchestration`;
  const now = await $.clock.now();
  const [worktrees, files] = await Promise.all([
    listMatching($, '.worktrees', WORKTREE, 'dir'),
    $.fs.list(orchestration).catch(() => []),
  ]);
  const stamp = (pattern: RegExp): Stamped[] =>
    files.flatMap((entry) => {
      const match = pattern.exec(entry.name);
      return match && entry.kind === 'file'
        ? [{ storyId: Number(match[1]), mtimeMs: entry.mtimeMs }]
        : [];
    });
  const envelopes = stamp(ENVELOPE);
  const inFlight = pickInFlight(worktrees, envelopes, stamp(GATE_LOG), now);
  const latest = newest(
    envelopes.filter((one) => now - one.mtimeMs <= RECENT_MS),
  );
  const last = latest
    ? toLastResult(
        latest.storyId,
        await readJson(
          $,
          `${orchestration}/story-deliver-terminal-${latest.storyId}.json`,
        ),
      )
    : null;
  return { next: { inFlight, last }, latest: last ? latest : undefined };
}

/** Toasts a landed or blocked result once; the first scan only records. */
async function announce(
  $: EngineInterface,
  next: Snapshot,
  latest: Stamped | undefined,
): Promise<void> {
  const seeded = await read($, isSeeded);
  if (!seeded) await update($, isSeeded, () => true);
  if (!latest || !next.last) return;
  const key = `${latest.storyId}:${latest.mtimeMs}`;
  if ((await read($, seen)).includes(key)) return;
  await update($, seen, (list) => [...list, key].slice(-50));
  if (seeded && ANNOUNCED.has(next.last.status)) {
    const pr = next.last.prNumber ? ` (PR #${next.last.prNumber})` : '';
    $.ui.toast(`Story #${next.last.storyId} ${next.last.status}${pr}`);
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const { next, latest } = await scan($);
    await update($, snapshot, () => next);
    await announce($, next, latest);
  } catch {
    // Read-only and best effort: a failed scan leaves the last drawing up.
  }
}

function describe({ inFlight, last }: Snapshot): string | null {
  if (inFlight) {
    const phase = inFlight.isClosing ? 'closing' : 'implementing';
    const stall =
      inFlight.stalledMinutes === null
        ? ''
        : ` · stalled? no gate output for ${inFlight.stalledMinutes}m`;
    return `mandrel · Story #${inFlight.storyId} ${phase}${stall}`;
  }
  if (last) {
    const pr = last.prNumber === null ? '' : ` · PR #${last.prNumber}`;
    const checks = last.checksStatus ? ` checks ${last.checksStatus}` : '';
    const took =
      last.elapsedSeconds === null
        ? ''
        : ` · ${Math.floor(last.elapsedSeconds / 60)}m${last.elapsedSeconds % 60}s`;
    return `mandrel · Story #${last.storyId} ${last.status}${pr}${checks}${took}`;
  }
  return null;
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await refresh($);
    $.clock.every(REFRESH_MS, () => {
      void refresh($);
    });
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    await refresh($);
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = e.props.hasSurvey ? null : describe(await read($, snapshot));
    if (line === null) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {line}
        </Text>
      </Box>
    );
  });
};
