import type { FsEntry, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';
import { describe, expect, mock, test } from 'claude-code/testing';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const MINUTE = 60_000;
const SURFACES = ['terminal', 'desktop'] as const;
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
};

type World = {
  files: Map<string, { text: string; mtimeMs: number }>;
  dirs: Map<string, number>;
  toasts: string[];
};

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/** The engine hands fs hooks absolute paths; the plugin folder is a test's working directory. */
const rel = (path: string): string => path.replace(/^.*\/mandrel-status\//, '');
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** An in-memory checkout beneath the plugin: fs, toasts, clock and the engine's own band. */
function world(on: On) {
  const state: World = { files: new Map(), dirs: new Map(), toasts: [] };
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
  on('ui.toast', (_$, e) => {
    state.toasts.push(e.text);
    return { value: undefined };
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
    if (parentOf(path)) dir(parentOf(path), mtimeMs);
    state.files.set(path, { text, mtimeMs });
  };
  const envelope = (storyId: number, status: string, mtimeMs = NOW) =>
    file(
      `temp/orchestration/story-deliver-terminal-${storyId}.json`,
      JSON.stringify({
        kind: 'story-deliver-terminal',
        storyId,
        status,
        elapsedSeconds: 339,
        pr: { number: storyId + 1, checksStatus: 'success' },
      }),
      mtimeMs,
    );
  return { state, clock, dir, file, envelope };
}

const start = ($: Engine) =>
  $.session.start({
    cwd: '/project',
    surface: 'terminal',
    isInteractive: true,
  });

const band = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({
    plugin: 'mandrel-status',
    surface,
    component: 'AbovePrompt',
    props: PROPS,
  });

describe('mandrel-status band', () => {
  test('names the in-flight Story on terminal and desktop', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.dir('.worktrees/story-5544', NOW - 5 * MINUTE);
    await start($);
    for (const surface of SURFACES) {
      const ui = await band($, surface);
      expect(
        (await ui.find({ text: /Story #5544 implementing/ }))?.text,
      ).toBeDefined();
      expect(await ui.find({ text: /stalled/ })).toBeUndefined();
    }
  });

  test('marks a close whose gate log went quiet as stalled', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.dir('.worktrees/story-5544', NOW - 30 * MINUTE);
    w.file(
      'temp/orchestration/close-gates-5544.log',
      'gates',
      NOW - 11 * MINUTE,
    );
    await start($);
    const ui = await band($, 'terminal');
    expect(
      await ui.find({
        text: /Story #5544 closing · stalled\? no gate output for 11m/,
      }),
    ).toBeDefined();
  });

  test('shows a landed result and toasts it exactly once across a reload', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.dir('temp/orchestration');
    await start($);
    expect(w.state.toasts).toEqual([]);
    w.envelope(5540, 'landed', NOW + MINUTE);
    await w.clock.advance(15_000);
    await w.clock.advance(15_000);
    await start($);
    await w.clock.advance(15_000);
    expect(w.state.toasts).toEqual(['Story #5540 landed (PR #5541)']);
    const ui = await band($, 'desktop');
    expect(
      await ui.find({
        text: /Story #5540 landed · PR #5541 checks success · 5m39s/,
      }),
    ).toBeDefined();
  });

  test('does not toast results already on disk when the session starts', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5540, 'landed', NOW - MINUTE);
    await start($);
    await w.clock.advance(15_000);
    expect(w.state.toasts).toEqual([]);
  });

  test('draws nothing outside a Mandrel checkout', async ($, on) => {
    const w = world(on);
    w.dir('.worktrees/story-5544');
    w.envelope(5540, 'landed');
    await start($);
    const ui = await band($, 'terminal');
    expect(await ui.find({ text: /mandrel/ })).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
  });

  test('draws nothing with no in-flight Story and no recent result', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5540, 'landed', NOW - 3 * 60 * MINUTE);
    await start($);
    const ui = await band($, 'terminal');
    expect(await ui.find({ text: /mandrel/ })).toBeUndefined();
  });

  test('a malformed config and envelope draw nothing and throw nothing', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.file('.agentrc.json', '{ not json');
    w.file('temp/orchestration/story-deliver-terminal-5540.json', '{ broken');
    await start($);
    await w.clock.advance(15_000);
    const ui = await band($, 'terminal');
    expect(await ui.find({ text: /mandrel/ })).toBeUndefined();
    expect(w.state.toasts).toEqual([]);
  });

  test('tempRoot follows .agentrc.local.json over .agentrc.json', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.file(
      '.agentrc.json',
      JSON.stringify({ project: { paths: { tempRoot: 'shared-temp' } } }),
    );
    w.file(
      '.agentrc.local.json',
      JSON.stringify({ project: { paths: { tempRoot: 'local-temp' } } }),
    );
    w.file(
      'shared-temp/orchestration/story-deliver-terminal-1.json',
      JSON.stringify({ status: 'landed', pr: { number: 2 } }),
    );
    w.file(
      'local-temp/orchestration/story-deliver-terminal-7.json',
      JSON.stringify({ status: 'blocked', pr: null }),
    );
    await start($);
    const ui = await band($, 'terminal');
    expect(await ui.find({ text: /Story #7 blocked/ })).toBeDefined();
    expect(await ui.find({ text: /Story #1 / })).toBeUndefined();
  });

  test('tempRoot defaults to temp when no config sets it', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.file('.agentrc.json', JSON.stringify({ project: {} }));
    w.envelope(5540, 'landed');
    await start($);
    const ui = await band($, 'terminal');
    expect(await ui.find({ text: /Story #5540 landed/ })).toBeDefined();
  });
});
