import type { FsEntry, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { describe, expect, mock, test } from 'claude-code/testing';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const SURFACES = ['terminal', 'desktop'] as const;
const ORCH = 'temp/orchestration';
/** Absolute paths the mod reads come back through `rel()` relative to this. */
const ABS = '/w/mandrel-status';
const TITLE = 'Messages can send a finished draft';
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
};
const APPROVAL = {
  blockClass: 'branch-protection-human-required',
  reason: 'review required',
  recovery: 'operator',
};

type World = {
  files: Map<string, { text: string; mtimeMs: number }>;
  dirs: Map<string, number>;
  copied: string[];
};

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/** The engine hands fs hooks absolute paths; the plugin folder is a test's working directory. */
const rel = (path: string): string => path.replace(/^.*\/mandrel-status\//, '');
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** An in-memory checkout beneath the plugin: fs, clipboard, clock and the engine's own band. */
function world(on: On) {
  const state: World = { files: new Map(), dirs: new Map(), copied: [] };
  const missing = (path: string) => ({ deny: `ENOENT: ${path}` });
  on('fs.exists', (_$, e) => ({
    value: state.dirs.has(rel(e.path)) || state.files.has(rel(e.path)),
  }));
  on('fs.read', (_$, e) => {
    const file = state.files.get(rel(e.path));
    if (!file) return missing(e.path);
    return { value: file.text };
  });
  on('fs.stat', (_$, e) => {
    const path = rel(e.path);
    const mtimeMs = state.dirs.get(path) ?? state.files.get(path)?.mtimeMs;
    if (mtimeMs === undefined) return missing(e.path);
    const kind = state.dirs.has(path) ? 'dir' : 'file';
    return { value: { kind, size: 0, mtimeMs, isLink: false } };
  });
  on('fs.list', (_$, e) => {
    const dir = rel(e.path);
    if (!state.dirs.has(dir)) return missing(e.path);
    const entries: FsEntry[] = [];
    for (const path of state.dirs.keys()) {
      if (parentOf(path) === dir) {
        entries.push({
          name: nameOf(path),
          kind: 'dir',
          size: 0,
          mtimeMs: 0,
          isLink: false,
        });
      }
    }
    for (const [path, file] of state.files) {
      if (parentOf(path) === dir) {
        entries.push({
          name: nameOf(path),
          kind: 'file',
          size: file.text.length,
          mtimeMs: file.mtimeMs,
          isLink: false,
        });
      }
    }
    return { value: entries };
  });
  on('ui.copy', (_$, e) => {
    state.copied.push(e.text);
    return { value: { isCopied: true } };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Text',
    children: ['engine band'],
  }));

  const clock = mock.clock(on, { now: NOW });
  const dir = (path: string, mtimeMs = NOW) => {
    for (let at = path; at.length > 0; at = parentOf(at)) {
      if (!state.dirs.has(at)) state.dirs.set(at, mtimeMs);
    }
    state.dirs.set(path, mtimeMs);
  };
  const file = (path: string, text: string, mtimeMs = NOW) => {
    const parent = parentOf(path);
    if (parent && !state.dirs.has(parent)) dir(parent, mtimeMs);
    state.files.set(path, { text, mtimeMs });
  };
  const json = (path: string, body: unknown, mtimeMs = NOW) =>
    file(path, JSON.stringify(body), mtimeMs);
  const envelope = (
    storyId: number,
    status: string,
    mtimeMs = NOW - MINUTE,
    extra: Record<string, unknown> = {},
  ) =>
    json(
      `${ORCH}/story-deliver-terminal-${storyId}.json`,
      {
        kind: 'story-deliver-terminal',
        storyId,
        status,
        pr: { number: storyId + 7, checksStatus: 'success' },
        ...extra,
      },
      mtimeMs,
    );
  const init = (storyId: number) =>
    file(
      `${ORCH}/story-init-result-${storyId}.log`,
      `--- STORY INIT RESULT ---\n${JSON.stringify(
        { storyId, storyTitle: TITLE, workCwd: '/x' },
        null,
        2,
      )}\n`,
      NOW - HOUR,
    );
  dir('.agents');
  return { state, clock, dir, file, json, envelope, init };
}

const start = ($: Engine) =>
  $.session.start({
    cwd: '/project',
    surface: 'terminal',
    isInteractive: true,
  });

const band = (
  $: Engine,
  surface: (typeof SURFACES)[number] = 'terminal',
  bodyColumns = PROPS.bodyColumns,
) =>
  $.ui.mount({
    plugin: 'mandrel-status',
    surface,
    component: 'AbovePrompt',
    props: { ...PROPS, bodyColumns },
  });

const textsOf = async (
  ui: Awaited<ReturnType<typeof band>>,
): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' }))
    .map((one) => one.text ?? '')
    .filter((text) => text !== 'engine band');

/** True when the band drew nothing of its own. */
const isQuiet = async (ui: Awaited<ReturnType<typeof band>>) =>
  (await textsOf(ui)).length === 0;

describe('mandrel-status band', () => {
  test('a block a person clears is one magenta line, action first, with Open PR', async ($, on) => {
    const w = world(on);
    w.init(8269);
    w.envelope(8269, 'blocked', NOW - MINUTE, {
      blocked: APPROVAL,
      pr: { number: 8276, url: 'https://github.com/o/r/pull/8276' },
    });
    await start($);
    for (const surface of SURFACES) {
      const ui = await band($, surface);
      const texts = await textsOf(ui);
      expect(texts, `${surface}: one line`).toEqual([
        `◆ #8269 needs your approval — review and approve the PR (PR #8276) · ${TITLE}`,
      ]);
      const line = await ui.find({ type: 'Text', text: /^◆ #8269/ });
      expect(line?.props.color).toBe('magenta');
      const link = await ui.find({ type: 'Link' });
      expect(link?.props.href).toBe('https://github.com/o/r/pull/8276');
      expect(await ui.find({ type: 'Button', text: 'Copy' })).toBeUndefined();
    }
  });

  for (const blockClass of [
    'checks-pending-timeout',
    'checks-failed',
    'api-race-other',
    'queue-ejected',
  ]) {
    test(`an agent-recoverable block draws nothing — ${blockClass}`, async ($, on) => {
      const w = world(on);
      w.envelope(8269, 'blocked', NOW - MINUTE, {
        blocked: { blockClass, reason: 'x', recovery: 'agent' },
        nextCommand: 'node .agents/scripts/pr-watch-with-update.js --pr 8276',
      });
      await start($);
      expect(await isQuiet(await band($))).toBe(true);
    });
  }

  test('an envelope without recovery falls back to the operator table', async ($, on) => {
    const w = world(on);
    w.envelope(1, 'blocked', NOW - MINUTE, {
      blocked: { blockClass: 'arm-failure', reason: 'x' },
    });
    w.envelope(2, 'blocked', NOW - 2 * MINUTE, {
      blocked: { blockClass: 'checks-pending-timeout', reason: 'x' },
    });
    await start($);
    expect(await textsOf(await band($))).toEqual([
      '◆ #1 auto-merge could not arm — merge the PR yourself (PR #8)',
    ]);
  });

  test('a failed close is red with Copy for its nextCommand', async ($, on) => {
    const w = world(on);
    const resume = 'node .agents/scripts/single-story-close.js --story 5544';
    w.envelope(5544, 'failed', NOW - MINUTE, {
      phase: 'base-sync',
      failure: { reason: 'conflict' },
      nextCommand: resume,
    });
    await start($);
    const ui = await band($);
    const line = await ui.find({
      type: 'Text',
      text: '✗ #5544 close failed at base-sync — resume the Story',
    });
    expect(line?.props.color).toBe('red');
    expect(await ui.find({ type: 'Link' })).toBeUndefined();
    await ui.press({ key: 'copy' });
    expect(w.state.copied).toEqual([resume]);
  });

  test('landed, pending and in-flight Stories draw nothing', async ($, on) => {
    const w = world(on);
    w.envelope(1, 'landed');
    w.envelope(2, 'pending');
    w.dir('.worktrees/story-3', NOW - MINUTE);
    await start($);
    expect(await isQuiet(await band($))).toBe(true);
  });

  test('the newest blocker leads and the rest are counted', async ($, on) => {
    const w = world(on);
    w.envelope(1, 'blocked', NOW - 2 * MINUTE, { blocked: APPROVAL });
    w.envelope(2, 'failed', NOW - MINUTE, { nextCommand: 'x' });
    await start($);
    expect(await textsOf(await band($))).toEqual([
      '✗ #2 close failed — resume the Story · +1 more',
    ]);
  });

  test('a worktree changed after the result means the Story was resumed', async ($, on) => {
    const w = world(on);
    w.envelope(8269, 'blocked', NOW - 5 * MINUTE, { blocked: APPROVAL });
    w.dir('.worktrees/story-8269', NOW - MINUTE);
    await start($);
    expect(await isQuiet(await band($))).toBe(true);
  });

  test('a blocker older than 24 hours draws nothing', async ($, on) => {
    const w = world(on);
    w.envelope(8269, 'blocked', NOW - 25 * HOUR, { blocked: APPROVAL });
    await start($);
    expect(await isQuiet(await band($))).toBe(true);
  });

  test('the title is dropped first, then the line is cut with an ellipsis', async ($, on) => {
    const w = world(on);
    w.init(8269);
    w.envelope(8269, 'blocked', NOW - MINUTE, { blocked: APPROVAL });
    await start($);
    expect(await textsOf(await band($, 'terminal', 90))).toEqual([
      '◆ #8269 needs your approval — review and approve the PR (PR #8276)',
    ]);
    const [narrow] = await textsOf(await band($, 'terminal', 50));
    expect(narrow).toHaveLength(32);
    expect(narrow?.endsWith('…')).toBe(true);
  });

  test('Hide hides this result; a newer result shows again', async ($, on) => {
    const w = world(on);
    w.envelope(8269, 'blocked', NOW - MINUTE, { blocked: APPROVAL });
    await start($);
    await (await band($)).press({ key: 'hide' });
    expect(await isQuiet(await band($))).toBe(true);
    w.envelope(8269, 'failed', NOW + MINUTE, { nextCommand: 'x' });
    await w.clock.advance(15 * SECOND);
    expect(await textsOf(await band($))).toEqual([
      '✗ #8269 close failed — resume the Story',
    ]);
  });

  test('the Open PR link falls back to the configured repo', async ($, on) => {
    const w = world(on);
    w.json('.agentrc.json', { github: { owner: 'o', repo: 'r' } });
    w.envelope(8269, 'blocked', NOW - MINUTE, { blocked: APPROVAL });
    await start($);
    const link = await (await band($)).find({ type: 'Link' });
    expect(link?.props.href).toBe('https://github.com/o/r/pull/8276');
  });

  test('a session in a linked worktree reads the main checkout', async ($, on) => {
    const w = world(on);
    w.file('.git', `gitdir: ${ABS}/main/.git/worktrees/quizzical\n`);
    w.dir('main/.agents');
    w.json(
      `main/${ORCH}/story-deliver-terminal-7.json`,
      { status: 'blocked', blocked: APPROVAL, pr: null },
      NOW - MINUTE,
    );
    await start($);
    expect(await textsOf(await band($))).toEqual([
      '◆ #7 needs your approval — review and approve the PR',
    ]);
  });

  test('draws nothing outside a Mandrel checkout', async ($, on) => {
    const w = world(on);
    w.state.dirs.delete('.agents');
    w.envelope(8269, 'blocked', NOW - MINUTE, { blocked: APPROVAL });
    await start($);
    expect(await isQuiet(await band($))).toBe(true);
  });

  test('malformed config and envelope files draw nothing and throw nothing', async ($, on) => {
    const w = world(on);
    w.file('.agentrc.json', '{ not json');
    w.file(`${ORCH}/story-deliver-terminal-5540.json`, '{ broken');
    await start($);
    await w.clock.advance(15 * SECOND);
    expect(await isQuiet(await band($))).toBe(true);
  });

  test('tempRoot follows .agentrc.local.json over .agentrc.json', async ($, on) => {
    const w = world(on);
    w.json('.agentrc.json', {
      project: { paths: { tempRoot: 'shared-temp' } },
    });
    w.json('.agentrc.local.json', {
      project: { paths: { tempRoot: 'local-temp' } },
    });
    const blocked = { status: 'blocked', blocked: APPROVAL, pr: null };
    w.json('shared-temp/orchestration/story-deliver-terminal-1.json', blocked);
    w.json('local-temp/orchestration/story-deliver-terminal-7.json', blocked);
    await start($);
    expect(await textsOf(await band($))).toEqual([
      '◆ #7 needs your approval — review and approve the PR',
    ]);
  });
});
