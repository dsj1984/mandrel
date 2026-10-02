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
const TITLE = 'Band v2';
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
};

type World = {
  files: Map<string, { text: string; mtimeMs: number }>;
  dirs: Map<string, number>;
  toasts: string[];
  opened: string[];
};

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/** The engine hands fs hooks absolute paths; the plugin folder is a test's working directory. */
const rel = (path: string): string => path.replace(/^.*\/mandrel-status\//, '');
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** An in-memory checkout beneath the plugin: fs, toasts, panes, clock and the engine's own band. */
function world(on: On) {
  const state: World = {
    files: new Map(),
    dirs: new Map(),
    toasts: [],
    opened: [],
  };
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
  on('ui.open', (_$, e) => {
    state.opened.push(e.id);
    return { value: { isPlaced: true } };
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
    mtimeMs = NOW,
    extra: Record<string, unknown> = {},
  ) =>
    json(
      `${ORCH}/story-deliver-terminal-${storyId}.json`,
      {
        kind: 'story-deliver-terminal',
        storyId,
        status,
        elapsedSeconds: 339,
        pr: { number: storyId + 1, checksStatus: 'success' },
        ...extra,
      },
      mtimeMs,
    );
  /** A Story's worktree, created after the files written inside it. */
  const worktree = (storyId: number, mtimeMs = NOW - 30 * MINUTE) =>
    dir(`.worktrees/story-${storyId}`, mtimeMs);
  const init = (storyId: number, mtimeMs = NOW - 30 * MINUTE) =>
    file(
      `${ORCH}/story-init-result-${storyId}.log`,
      `--- STORY INIT RESULT ---\n${JSON.stringify(
        { storyId, storyTitle: TITLE, workCwd: '/x' },
        null,
        2,
      )}\n`,
      mtimeMs,
    );
  /** Reflog lines under the worktree's gitdir; `at` in epoch ms per commit. */
  const commits = (
    storyId: number,
    list: { subject: string; at: number }[],
  ) => {
    const gitdir = `.git/worktrees/story-${storyId}`;
    file(`.worktrees/story-${storyId}/.git`, `gitdir: ${ABS}/${gitdir}\n`);
    const lines = [
      `${'0'.repeat(40)} ${'a'.repeat(40)} Test <t@e> ${Math.floor((NOW - HOUR) / 1000)} -0400\treset: moving to HEAD`,
      ...list.map(
        (one) =>
          `${'a'.repeat(40)} ${'b'.repeat(40)} Test <t@e> ${Math.floor(one.at / 1000)} -0400\tcommit: ${one.subject}`,
      ),
    ];
    file(`${gitdir}/logs/HEAD`, `${lines.join('\n')}\n`);
  };
  const verdict = (
    storyId: number,
    round: number,
    verdicts: string[],
    mtimeMs: number,
  ) =>
    json(
      `temp/scratch/story-${storyId}/acceptance-verdict-round-${round}.json`,
      {
        storyId,
        round,
        criteria: verdicts.map((one, index) => ({
          index,
          criterion: `AC-${index + 1}`,
          verdict: one,
          evidence: 'x',
        })),
      },
      mtimeMs,
    );
  const step = (storyId: number, name: string, mtimeMs: number) =>
    file(`${ORCH}/story-handoff-${storyId}-${name}.log`, 'ok', mtimeMs);
  return {
    state,
    clock,
    dir,
    file,
    json,
    envelope,
    worktree,
    init,
    commits,
    verdict,
    step,
  };
}

const start = ($: Engine) =>
  $.session.start({
    cwd: '/project',
    surface: 'terminal',
    isInteractive: true,
  });

const band = (
  $: Engine,
  surface: (typeof SURFACES)[number],
  bodyColumns = PROPS.bodyColumns,
) =>
  $.ui.mount({
    plugin: 'mandrel-status',
    surface,
    component: 'AbovePrompt',
    props: { ...PROPS, bodyColumns },
  });

const textOf = async (
  ui: Awaited<ReturnType<typeof band>>,
  pattern: RegExp,
): Promise<string | undefined> =>
  (await ui.find({ type: 'Text', text: pattern }))?.text;

type W = ReturnType<typeof world>;

/** Stage fixtures, each adding the evidence of one stage over the previous. */
const STAGE_CASES: {
  name: string;
  build: (w: W) => void;
  strip: RegExp;
  detail: RegExp;
}[] = [
  {
    name: 'start: the init log alone',
    build: (w) => w.init(5544),
    strip: /^● start ─ ○ build ─ ○ check ─ ○ handoff ─ ○ close ─ ○ merge/,
    detail: /· initialized ·/,
  },
  {
    name: 'build: reflog commits',
    build: (w) => {
      w.init(5544);
      w.commits(5544, [
        { subject: 'feat: add the strip', at: NOW - 20 * MINUTE },
        { subject: 'test: cover the strip', at: NOW - 15 * MINUTE },
      ]);
    },
    strip: /^✓ start ─ ● build ─ ○ check/,
    detail: /2 commits · test: cover the strip/,
  },
  {
    name: 'check: the highest verdict round',
    build: (w) => {
      w.init(5544);
      w.commits(5544, [{ subject: 'feat: x', at: NOW - 20 * MINUTE }]);
      w.verdict(5544, 1, ['met', 'unmet', 'unmet', 'met'], NOW - 12 * MINUTE);
      w.verdict(5544, 2, ['met', 'met', 'partial', 'met'], NOW - 10 * MINUTE);
    },
    strip: /^✓ start ─ ✓ build ─ ● check ─ ○ handoff/,
    detail: /round 2 · 3\/4 met/,
  },
  {
    name: 'handoff: the newest step log',
    build: (w) => {
      w.init(5544);
      w.verdict(5544, 1, ['met'], NOW - 12 * MINUTE);
      w.step(5544, 'preflight-lint', NOW - 8 * MINUTE);
      w.step(5544, 'credited-run', NOW - 5 * MINUTE);
    },
    strip: /^✓ start ─ ✓ build ─ ✓ check ─ ● handoff ─ ○ close/,
    detail: /step credited-run/,
  },
  {
    name: 'close: the gate log’s last prefix',
    build: (w) => {
      w.init(5544);
      w.step(5544, 'push', NOW - 8 * MINUTE);
      w.json(`${ORCH}/story-handoff-5544.json`, {}, NOW - 7 * MINUTE);
      w.file(
        `${ORCH}/close-gates-5544.log`,
        '[typecheck] ok\n[lint] running biome\n',
        NOW - 30 * SECOND,
      );
    },
    strip: /^✓ start ─ ✓ build ─ ✓ check ─ ✓ handoff ─ ● close ─ ○ merge/,
    detail: /gate lint/,
  },
  {
    name: 'merge: a progress file in confirm-merge',
    build: (w) => {
      w.init(5544);
      w.file(`${ORCH}/close-gates-5544.log`, '[lint] ok', NOW - 5 * MINUTE);
      w.json(
        `${ORCH}/story-progress-5544.json`,
        {
          kind: 'story-progress',
          storyId: 5544,
          stage: 'close',
          phase: 'confirm-merge',
          stageStartedAt: new Date(NOW - 6 * MINUTE).toISOString(),
          phaseStartedAt: new Date(NOW - 2 * MINUTE).toISOString(),
          prNumber: 5560,
          updatedAt: new Date(NOW - MINUTE).toISOString(),
        },
        NOW - MINUTE,
      );
    },
    strip: /^✓ start ─ ✓ build ─ ✓ check ─ ✓ handoff ─ ✓ close ─ ● merge/,
    detail: /PR #5560 · confirm-merge · 2m0s/,
  },
  {
    name: 'merge: a pending terminal envelope',
    build: (w) => {
      w.init(5544);
      w.envelope(5544, 'pending', NOW - MINUTE, {
        nextCommand: 'node .agents/scripts/single-story-close.js --story 5544',
      });
    },
    strip: /● merge/,
    detail: /PR #5545 · waiting on merge · pending/,
  },
];

describe('mandrel-status band', () => {
  for (const one of STAGE_CASES) {
    test(`marks the stage and its detail — ${one.name}`, async ($, on) => {
      const w = world(on);
      w.dir('.agents');
      one.build(w);
      w.worktree(5544);
      await start($);
      for (const surface of SURFACES) {
        const ui = await band($, surface);
        expect(await textOf(ui, /^mandrel · #5544 Band v2/)).toBeDefined();
        const second = await textOf(ui, one.strip);
        expect(second, `${surface}: strip`).toBeDefined();
        expect(second).toMatch(one.detail);
      }
    });
  }

  test('a commit after the last verdict round returns the Story to build', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544);
    w.verdict(5544, 1, ['met', 'unmet'], NOW - 10 * MINUTE);
    w.commits(5544, [{ subject: 'fix: redraft', at: NOW - 5 * MINUTE }]);
    w.worktree(5544);
    await start($);
    const ui = await band($, 'terminal');
    expect(
      await textOf(ui, /● build ─ .* · 1 commit · fix: redraft/),
    ).toBeDefined();
  });

  test('a session in a linked worktree reads the main checkout', async ($, on) => {
    const w = world(on);
    w.file('.git', `gitdir: ${ABS}/main/.git/worktrees/quizzical\n`);
    w.dir('main/.agents');
    w.dir('main/.worktrees/story-5544', NOW - 5 * MINUTE);
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel · #5544/)).toBeDefined();
  });

  test('learned medians give an ETA, and turn the band yellow past twice the usual', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    [60, 90, 120].forEach((seconds, index) => {
      w.envelope(5530 + index, 'landed', NOW - 5 * HOUR, {
        phaseDurations: { 'close-validation': seconds, 'confirm-merge': 400 },
      });
    });
    w.init(5544);
    w.json(`${ORCH}/story-handoff-5544.json`, {}, NOW - 2 * MINUTE);
    w.file(`${ORCH}/close-gates-5544.log`, '[test] running', NOW);
    w.worktree(5544);
    await start($);
    let ui = await band($, 'terminal');
    const calm = await ui.find({
      type: 'Text',
      text: /gate test · 2m0s of usual ~1m30s/,
    });
    expect(calm).toBeDefined();
    expect(calm?.props.color).toBeUndefined();
    expect(await textOf(ui, /stalled/)).toBeUndefined();
    await w.clock.advance(90 * SECOND);
    ui = await band($, 'terminal');
    const stalled = await ui.find({
      type: 'Text',
      text: /3m30s of usual ~1m30s · stalled\?/,
    });
    expect(stalled?.props.color).toBe('yellow');
    expect(
      (await ui.find({ type: 'Text', text: /^mandrel · #5544/ }))?.props.color,
    ).toBe('yellow');
  });

  test('with fewer than three samples the 10-minute gate-log rule governs', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5530, 'landed', NOW - 5 * HOUR, {
      phaseDurations: { 'close-validation': 10 },
    });
    w.file(`${ORCH}/close-gates-5544.log`, '[test] quiet', NOW - 11 * MINUTE);
    w.worktree(5544);
    await start($);
    const ui = await band($, 'desktop');
    expect(await textOf(ui, /of usual/)).toBeUndefined();
    const line = await ui.find({
      type: 'Text',
      text: /stalled\? no gate output for 11m/,
    });
    expect(line?.props.color).toBe('yellow');
  });

  test('a blocked result renders red with its class and the next command', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544, NOW - HOUR);
    w.envelope(5544, 'blocked', NOW - MINUTE, {
      blocked: { blockClass: 'checks-failed', reason: 'CI red' },
      nextCommand: 'node .agents/scripts/single-story-close.js --story 5544',
    });
    await start($);
    for (const surface of SURFACES) {
      const ui = await band($, surface);
      const head = await ui.find({
        type: 'Text',
        text: /^✗ mandrel · #5544 Band v2 · blocked: checks-failed · PR #5545/,
      });
      expect(head?.props.color).toBe('red');
      const next = await ui.find({
        type: 'Text',
        text: 'next: node .agents/scripts/single-story-close.js --story 5544',
      });
      expect(next?.props.color).toBe('red');
      expect(await textOf(ui, /● /)).toBeUndefined();
    }
  });

  test('a failed result carries its reason', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5544, 'failed', NOW - MINUTE, {
      failure: { reason: 'push rejected' },
      nextCommand: 'node .agents/scripts/deliver-recover.js --story 5544',
    });
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /failed: push rejected/)).toBeDefined();
    expect(
      await textOf(ui, /^next: node .agents\/scripts\/deliver-recover.js/),
    ).toBeDefined();
  });

  test('a landed result collapses to one green line', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5540, NOW - HOUR);
    w.file(
      `${ORCH}/follow-ups-rollup-5540.md`,
      '### follow-ups\n\n- tighten the floor\n- drop a dead export\n',
      NOW - MINUTE,
    );
    w.envelope(5540, 'landed', NOW - MINUTE);
    await start($);
    for (const surface of SURFACES) {
      const ui = await band($, surface);
      const line = await ui.find({
        type: 'Text',
        text: /^✓ mandrel · #5540 Band v2 · landed in 5m39s · PR #5541 · 2 follow-ups$/,
      });
      expect(line?.props.color).toBe('green');
      expect(await ui.findAll({ type: 'Text' })).toHaveLength(1);
    }
  });

  test('a live run ledger adds a run line; a stale one does not', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5543, 'landed', NOW - 40 * MINUTE);
    w.init(5544);
    w.worktree(5544);
    w.json('temp/run-abc123/ledger.json', {
      kind: 'deliver-run-ledger',
      runId: 'abc123',
      stories: [5543, 5544, 5545],
      dispatched: [5543, 5544],
      updatedAt: new Date(NOW - 10 * MINUTE).toISOString(),
    });
    w.json('temp/run-old/ledger.json', {
      kind: 'deliver-run-ledger',
      runId: 'old',
      stories: [1, 2],
      dispatched: [1],
      updatedAt: new Date(NOW - 3 * HOUR).toISOString(),
    });
    await start($);
    const ui = await band($, 'terminal');
    expect(
      await textOf(ui, /^run 1\/3 landed · #5544 start · 1 queued$/),
    ).toBeDefined();
    expect(await ui.findAll({ type: 'Text', text: /^run / })).toHaveLength(1);
  });

  test('under 80 body columns only the first line renders', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544);
    w.worktree(5544);
    await start($);
    const ui = await band($, 'terminal', 79);
    expect(await textOf(ui, /^mandrel · #5544/)).toBeDefined();
    expect(await textOf(ui, /● start/)).toBeUndefined();
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(1);
  });

  test('long text is cut short with an ellipsis, never wrapped', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544);
    w.commits(5544, [{ subject: 'x'.repeat(300), at: NOW - MINUTE }]);
    w.worktree(5544);
    await start($);
    const ui = await band($, 'terminal', 100);
    const line = await textOf(ui, /● build/);
    expect(line?.length).toBe(100);
    expect(line?.endsWith('…')).toBe(true);
  });

  test('Hide hides the band until the focus Story changes', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.worktree(5544);
    await start($);
    let ui = await band($, 'terminal');
    await ui.press({ key: 'hide' });
    ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel/)).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
    await w.clock.advance(15 * SECOND);
    ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel/)).toBeUndefined();
    w.worktree(5550, NOW + 20 * SECOND);
    await w.clock.advance(15 * SECOND);
    ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel · #5550/)).toBeDefined();
  });

  test('Details opens the mandrel-status pane listing stages, steps and phases', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    [100, 200, 300].forEach((seconds, index) => {
      w.envelope(5530 + index, 'landed', NOW - 5 * HOUR, {
        phaseDurations: { 'close-validation': seconds },
      });
    });
    w.init(5544);
    w.step(5544, 'preflight-lint', NOW - 8 * MINUTE);
    w.step(5544, 'credited-run', NOW - 5 * MINUTE);
    w.worktree(5544);
    await start($);
    const ui = await band($, 'terminal');
    await ui.press({ key: 'details' });
    expect(w.state.opened).toEqual(['mandrel-status']);
    const pane = await $.ui.mount({
      plugin: 'mandrel-status',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'mandrel-status',
      props: {
        title: 'mandrel-status',
        isFocused: false,
        bodyColumns: 80,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    });
    expect(
      await pane.find({ type: 'Text', text: /^Story #5544 Band v2/ }),
    ).toBeDefined();
    for (const heading of ['Stages', 'Handoff steps', 'Close phases']) {
      expect(
        await pane.find({ type: 'Text', text: heading }),
        heading,
      ).toBeDefined();
    }
    expect(await pane.find({ type: 'Text', text: /✓ start/ })).toBeDefined();
    expect(
      await pane.find({ type: 'Text', text: /● handoff .* 8m0s$/ }),
    ).toBeDefined();
    expect(
      await pane.find({ type: 'Text', text: /^ {2}credited-run/ }),
    ).toBeDefined();
    expect(
      await pane.find({
        type: 'Text',
        text: /close-validation +— \(usual ~3m20s\)/,
      }),
    ).toBeDefined();
  });

  test('shows a landed result and toasts it exactly once across a reload', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.dir(ORCH);
    await start($);
    expect(w.state.toasts).toEqual([]);
    w.envelope(5540, 'landed', NOW + MINUTE);
    await w.clock.advance(15 * SECOND);
    await w.clock.advance(15 * SECOND);
    await start($);
    await w.clock.advance(15 * SECOND);
    expect(w.state.toasts).toEqual(['Story #5540 landed (PR #5541)']);
    const ui = await band($, 'desktop');
    expect(
      await textOf(ui, /✓ mandrel · #5540 · landed in 5m39s · PR #5541/),
    ).toBeDefined();
  });

  test('does not toast results already on disk when the session starts', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5540, 'landed', NOW - MINUTE);
    await start($);
    await w.clock.advance(15 * SECOND);
    expect(w.state.toasts).toEqual([]);
  });

  test('draws nothing outside a Mandrel checkout', async ($, on) => {
    const w = world(on);
    w.dir('.worktrees/story-5544');
    w.envelope(5540, 'landed');
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel/)).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
  });

  test('draws nothing with no in-flight Story and no recent result', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5540, 'landed', NOW - 3 * HOUR);
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel/)).toBeUndefined();
  });

  test('malformed config, envelope, ledger and progress files draw nothing and throw nothing', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.file('.agentrc.json', '{ not json');
    w.file(`${ORCH}/story-deliver-terminal-5540.json`, '{ broken');
    w.file(`${ORCH}/story-progress-5540.json`, '{ broken');
    w.file('temp/run-x/ledger.json', '{ broken');
    await start($);
    await w.clock.advance(15 * SECOND);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /mandrel/)).toBeUndefined();
    expect(w.state.toasts).toEqual([]);
  });

  test('tempRoot follows .agentrc.local.json over .agentrc.json', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.json('.agentrc.json', {
      project: { paths: { tempRoot: 'shared-temp' } },
    });
    w.json('.agentrc.local.json', {
      project: { paths: { tempRoot: 'local-temp' } },
    });
    w.json('shared-temp/orchestration/story-deliver-terminal-1.json', {
      status: 'landed',
      pr: { number: 2 },
    });
    w.json('local-temp/orchestration/story-deliver-terminal-7.json', {
      status: 'blocked',
      pr: null,
    });
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /#7 · blocked/)).toBeDefined();
    expect(await textOf(ui, /#1 /)).toBeUndefined();
  });

  test('tempRoot defaults to temp when no config sets it', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.json('.agentrc.json', { project: {} });
    w.envelope(5540, 'landed');
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /#5540 · landed/)).toBeDefined();
  });
});
