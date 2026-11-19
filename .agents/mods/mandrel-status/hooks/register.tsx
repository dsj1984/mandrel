// mandrel-status — a beta, read-only Claude Code mod. It draws one line above
// the prompt only when a /mandrel-deliver Story is stopped on something a
// person has to do, and nothing otherwise. Nothing in Mandrel depends on it;
// see .agents/docs/runbooks/mods.md.

import type { EngineInterface, FsEntry, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';

import type { Blocker, Fix } from '../types';

const REFRESH_MS = 15_000;
/** How long an unanswered blocker stays on the band. */
const SHOWN_MS = 24 * 60 * 60_000;
/** Cells the action button and Hide take at the end of the line. */
const BUTTON_CELLS = 18;

const ENVELOPE = /^story-deliver-terminal-(\d+)\.json$/;
const WORKTREE = /^story-(\d+)$/;
const GITDIR = /^gitdir:\s*(.+?)\s*$/m;
const MAIN_OF = /^(.+)\/\.git\/worktrees\/[^/]+$/;
const TITLE = /"storyTitle"\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * Block classes a person clears, worded for that person. Mirrors the
 * `operator` rows of BLOCK_CLASS_RECOVERY in block-class-recovery.js, which an
 * envelope's `blocked.recovery` carries; this table is the fallback for an
 * envelope without it, and the wording for every row.
 */
const OPERATOR_BLOCKS: Record<string, Fix> = {
  'branch-protection-human-required': {
    label: 'needs your approval',
    action: 'review and approve the PR',
    button: 'pr',
  },
  'arm-failure': {
    label: 'auto-merge could not arm',
    action: 'merge the PR yourself',
    button: 'pr',
  },
  'predicate-refused': {
    label: 'a repo rule refused the merge',
    action: 'check the PR',
    button: 'pr',
  },
  'merge-queue-rest-unsupported': {
    label: 'the merge queue needs a hand',
    action: 'add the PR to the merge queue',
    button: 'pr',
  },
};
const UNKNOWN_BLOCK: Fix = {
  label: 'blocked',
  action: 'see the Story',
  button: 'pr',
};

const blockers = atom(
  { plugin: 'mandrel-status', key: 'blockers' } as const,
  [] as Blocker[],
);
const hiddenFor = atom(
  { plugin: 'mandrel-status', key: 'hiddenFor' } as const,
  null as string | null,
);

// ---------------------------------------------------------------- reading

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const join = (root: string, path: string): string =>
  root === '.' || path.startsWith('/') ? path : `${root}/${path}`;

async function readText(
  $: EngineInterface,
  path: string,
): Promise<string | null> {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The main checkout: a linked worktree's `.git` file names it as
 * `gitdir: <main>/.git/worktrees/<name>`; anywhere else it is `.`.
 */
async function resolveRoot($: EngineInterface): Promise<string> {
  const gitdir = GITDIR.exec((await readText($, '.git')) ?? '')?.[1];
  const main = gitdir
    ? MAIN_OF.exec(gitdir.replace(/\\/g, '/'))?.[1]
    : undefined;
  return main ?? '.';
}

type Config = {
  project?: { paths?: { tempRoot?: unknown } };
  github?: { owner?: unknown; repo?: unknown };
};

/**
 * `.agentrc.local.json` wins over `.agentrc.json`, key by key; tempRoot is
 * `temp` when neither sets it, and the repo address needs both owner and repo.
 */
async function resolveConfig(
  $: EngineInterface,
  root: string,
): Promise<{ temp: string; repoUrl: string | null }> {
  const configs = [
    (await readJson($, join(root, '.agentrc.local.json'))) as Config,
    (await readJson($, join(root, '.agentrc.json'))) as Config,
  ];
  const first = (pick: (config: Config) => unknown): string | null =>
    configs.map((config) => str(pick(config ?? {}))).find(Boolean) ?? null;
  const owner = first((config) => config?.github?.owner);
  const repo = first((config) => config?.github?.repo);
  return {
    temp: join(
      root,
      first((config) => config?.project?.paths?.tempRoot) ?? 'temp',
    ),
    repoUrl: owner && repo ? `https://github.com/${owner}/${repo}` : null,
  };
}

/** When each `.worktrees/story-<id>/` last changed: a resumed Story is not waiting. */
async function worktreeTimes(
  $: EngineInterface,
  dir: string,
): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  for (const entry of await $.fs.list(dir).catch(() => [] as FsEntry[])) {
    const match = WORKTREE.exec(entry.name);
    if (!match || entry.kind !== 'dir') continue;
    const mtimeMs = await $.fs
      .stat(`${dir}/${entry.name}`)
      .then((stat) => stat.mtimeMs)
      .catch(() => 0);
    times.set(Number(match[1]), mtimeMs);
  }
  return times;
}

type Envelope = {
  status?: unknown;
  phase?: unknown;
  nextCommand?: unknown;
  pr?: { number?: unknown; url?: unknown } | null;
  blocked?: { blockClass?: unknown; recovery?: unknown } | null;
};

/** What a person has to do about one terminal envelope, or null when nothing. */
function fixOf(raw: unknown): Fix | null {
  const body = (raw ?? {}) as Envelope;
  const status = str(body.status);
  if (status === 'blocked') {
    const blockClass = str(body.blocked?.blockClass) ?? '';
    const recovery = str(body.blocked?.recovery);
    const known = OPERATOR_BLOCKS[blockClass];
    if (recovery === 'agent' || (recovery === null && !known)) return null;
    return known ?? UNKNOWN_BLOCK;
  }
  if (status === 'failed') {
    const phase = str(body.phase);
    return {
      label: phase ? `close failed at ${phase}` : 'close failed',
      action: 'resume the Story',
      button: 'copy',
    };
  }
  if (status === 'escalated')
    return {
      label: 'too big for the light path',
      action: 'plan it',
      button: 'copy',
    };
  return null;
}

async function toBlocker(
  $: EngineInterface,
  orchestration: string,
  repoUrl: string | null,
  storyId: number,
  at: number,
): Promise<Blocker | null> {
  const raw = await readJson(
    $,
    `${orchestration}/story-deliver-terminal-${storyId}.json`,
  );
  const fix = fixOf(raw);
  if (!fix) return null;
  const body = raw as Envelope;
  const prNumber = num(body.pr?.number);
  const prUrl =
    str(body.pr?.url) ??
    (prNumber !== null && repoUrl ? `${repoUrl}/pull/${prNumber}` : null);
  const init = await readText(
    $,
    `${orchestration}/story-init-result-${storyId}.log`,
  );
  const quoted = init ? TITLE.exec(init)?.[1] : undefined;
  let title: string | null = null;
  try {
    title = quoted ? str(JSON.parse(quoted)) : null;
  } catch {
    title = null;
  }
  return {
    storyId,
    at,
    title,
    fix,
    prNumber,
    prUrl,
    command: str(body.nextCommand),
  };
}

/**
 * Every Story stopped on a person, newest first: a terminal envelope from the
 * last 24 hours that needs one, with no newer change to its worktree.
 */
async function scan($: EngineInterface): Promise<Blocker[]> {
  const root = await resolveRoot($);
  if (!(await $.fs.exists(join(root, '.agents')).catch(() => false))) return [];
  const { temp, repoUrl } = await resolveConfig($, root);
  const orchestration = `${temp}/orchestration`;
  const now = await $.clock.now();
  const [files, worktrees] = await Promise.all([
    $.fs.list(orchestration).catch(() => [] as FsEntry[]),
    worktreeTimes($, join(root, '.worktrees')),
  ]);
  const found: Blocker[] = [];
  for (const entry of files) {
    const match = ENVELOPE.exec(entry.name);
    if (!match || entry.kind !== 'file') continue;
    const storyId = Number(match[1]);
    if (now - entry.mtimeMs > SHOWN_MS) continue;
    if ((worktrees.get(storyId) ?? 0) > entry.mtimeMs) continue;
    const blocker = await toBlocker(
      $,
      orchestration,
      repoUrl,
      storyId,
      entry.mtimeMs,
    );
    if (blocker) found.push(blocker);
  }
  return found.sort((a, b) => b.at - a.at);
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const next = await scan($);
    await update($, blockers, () => next);
  } catch {
    // Read-only and best effort: a failed scan leaves the last drawing up.
  }
}

// --------------------------------------------------------------- drawing

/** Cut short with an ellipsis, never wrapped. */
function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? '…' : `${text.slice(0, width - 1)}…`;
}

/**
 * `◆ #<id> <label> — <action> PR #<n>`, then `· +N more`, then the title,
 * which is the first thing dropped when the line runs out of room.
 */
function lineOf(list: Blocker[], width: number): string {
  const [top] = list;
  if (!top) return '';
  const glyph = top.fix.button === 'pr' ? '◆' : '✗';
  const pr =
    top.fix.button === 'pr' && top.prNumber !== null
      ? ` (PR #${top.prNumber})`
      : '';
  const more = list.length > 1 ? ` · +${list.length - 1} more` : '';
  const core = `${glyph} #${top.storyId} ${top.fix.label} — ${top.fix.action}${pr}${more}`;
  const titled = top.title ? `${core} · ${top.title}` : core;
  return titled.length <= width ? titled : cut(core, width);
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
    if (e.props.hasSurvey) return next(e);
    const list = await read($, blockers);
    const [top] = list;
    if (!top) return next(e);
    const hideKey = `${top.storyId}:${top.at}`;
    if ((await read($, hiddenFor)) === hideKey) return next(e);
    const { Box, Button, Link, Text } = $.ui.resolve(e);
    const color = top.fix.button === 'pr' ? 'magenta' : 'red';
    const width = Math.max(20, e.props.bodyColumns - BUTTON_CELLS);
    const command = top.command;
    return (
      <Box>
        <Text color={color} wrap="truncate">
          {lineOf(list, width)}
        </Text>
        {top.fix.button === 'pr' && top.prUrl ? (
          <Link key="pr" href={top.prUrl} label="Open PR" />
        ) : null}
        {top.fix.button === 'copy' && command ? (
          <Button
            key="copy"
            label="Copy"
            onPress={(press) => {
              void $.ui.copy({ text: command, surface: press.surface });
            }}
          />
        ) : null}
        <Button
          key="hide"
          label="Hide"
          onPress={() => update($, hiddenFor, () => hideKey)}
        />
      </Box>
    );
  });
};
