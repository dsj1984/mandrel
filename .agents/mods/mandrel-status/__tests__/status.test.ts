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
  copied: string[];
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
    copied: [],
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
  on('ui.copy', (_$, e) => {
    state.copied.push(e.text);
    return { value: { isCopied: true } };
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

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'mandrel-status',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mandrel-status',
    props: {
      title: 'mandrel-status',
      isFocused: false,
      bodyColumns: 100,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  });

const textsOf = async (
  ui: Awaited<ReturnType<typeof band>>,
): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map((one) => one.text ?? '');

type W = ReturnType<typeof world>;

/** Close-validation medians of 60/90/120s, and a Story 2 minutes into it. */
function slowCloseStory(w: W) {
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
}

/** Stage fixtures, each adding the evidence of one stage over the previous. */
const STAGE_CASES: { name: string; build: (w: W) => void; line: RegExp }[] = [
  {
    name: 'start: the init log alone',
    build: (w) => w.init(5544),
    line: /^● #5544 Band v2 {3}▰▱▱▱▱▱ start {3}30:00$/,
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
    line: /^● #5544 Band v2 {3}▰▰▱▱▱▱ build · 2 commits {3}20:00$/,
  },
  {
    name: 'check: the highest verdict round',
    build: (w) => {
      w.init(5544);
      w.commits(5544, [{ subject: 'feat: x', at: NOW - 20 * MINUTE }]);
      w.verdict(5544, 1, ['met', 'unmet', 'unmet', 'met'], NOW - 12 * MINUTE);
      w.verdict(5544, 2, ['met', 'met', 'partial', 'met'], NOW - 10 * MINUTE);
    },
    line: /▰▰▰▱▱▱ check · round 2 · 3\/4 met {3}12:00$/,
  },
  {
    name: 'handoff: the newest step log',
    build: (w) => {
      w.init(5544);
      w.verdict(5544, 1, ['met'], NOW - 12 * MINUTE);
      w.step(5544, 'preflight-lint', NOW - 8 * MINUTE);
      w.step(5544, 'credited-run', NOW - 5 * MINUTE);
    },
    line: /▰▰▰▰▱▱ handoff · credited-run {3}8:00$/,
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
    line: /▰▰▰▰▰▱ close · gate lint {3}7:00$/,
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
    line: /▰▰▰▰▰▰ merge · PR #5560 · confirm-merge {3}2:00$/,
  },
  {
    name: 'merge: a pending terminal envelope',
    build: (w) => {
      w.init(5544);
      w.envelope(5544, 'pending', NOW - MINUTE, {
        nextCommand: 'node .agents/scripts/single-story-close.js --story 5544',
      });
    },
    line: /▰▰▰▰▰▰ merge · PR #5545 · waiting on merge {3}pending$/,
  },
];

describe('mandrel-status band', () => {
  for (const one of STAGE_CASES) {
    test(`a healthy Story is one line with its meter and step — ${one.name}`, async ($, on) => {
      const w = world(on);
      w.dir('.agents');
      one.build(w);
      w.worktree(5544);
      await start($);
      for (const surface of SURFACES) {
        const ui = await band($, surface);
        const texts = await textsOf(ui);
        expect(texts, `${surface}: one line`).toHaveLength(1);
        expect(texts[0]).toMatch(one.line);
        expect(texts[0]).not.toMatch(/mandrel ·| ─ /);
        const line = await ui.find({ type: 'Text', text: one.line });
        expect(line?.props.color).toBeUndefined();
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
    expect(await textOf(ui, /▰▰▱▱▱▱ build · 1 commit /)).toBeDefined();
  });

  test('a session in a linked worktree reads the main checkout', async ($, on) => {
    const w = world(on);
    w.file('.git', `gitdir: ${ABS}/main/.git/worktrees/quizzical\n`);
    w.dir('main/.agents');
    w.dir('main/.worktrees/story-5544', NOW - 5 * MINUTE);
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /^● #5544/)).toBeDefined();
  });

  test('time shows against the usual; past twice the usual the band turns yellow and says why, once', async ($, on) => {
    const w = world(on);
    slowCloseStory(w);
    await start($);
    let ui = await band($, 'terminal');
    const calm = await ui.find({
      type: 'Text',
      text: /▰▰▰▰▰▱ close · gate test {3}2:00 \/ ~1:30$/,
    });
    expect(calm?.props.color).toBeUndefined();
    expect(await textsOf(ui)).toHaveLength(1);
    await w.clock.advance(90 * SECOND);
    ui = await band($, 'terminal');
    const head = await ui.find({
      type: 'Text',
      text: /^▲ #5544 Band v2 {3}▰▰▰▰▰▱ close · gate test {3}3:30 \/ ~1:30$/,
    });
    expect(head?.props.color).toBe('yellow');
    const why = await ui.find({
      type: 'Text',
      text: '↳ 2.3× usual · gate log quiet 1m · last gate test',
    });
    expect(why?.props.color).toBe('yellow');
    await w.clock.advance(45 * SECOND);
    expect(w.state.toasts).toEqual([
      'Story #5544 is slow: close-validation 3:15 of usual ~1:30',
    ]);
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
    expect(await textOf(ui, / \/ ~/)).toBeUndefined();
    const line = await ui.find({
      type: 'Text',
      text: '↳ gate log quiet 11m · last gate test',
    });
    expect(line?.props.color).toBe('yellow');
  });

  test('a blocked result needs you: magenta, the resume command, and Copy', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544, NOW - HOUR);
    const resume = 'node .agents/scripts/single-story-close.js --story 5544';
    w.envelope(5544, 'blocked', NOW - MINUTE, {
      blocked: { blockClass: 'checks-failed', reason: 'CI red' },
      nextCommand: resume,
    });
    await start($);
    for (const surface of SURFACES) {
      const ui = await band($, surface);
      const head = await ui.find({
        type: 'Text',
        text: /^◆ #5544 Band v2 {3}needs you at start · checks-failed$/,
      });
      expect(head?.props.color).toBe('magenta');
      const next = await ui.find({ type: 'Text', text: `↳ ${resume}` });
      expect(next?.props.color).toBe('magenta');
    }
    const ui = await band($, 'terminal');
    await ui.press({ key: 'copy' });
    expect(w.state.copied).toEqual([resume]);
  });

  test('blocked at check names the unmet acceptance ids', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544, NOW - HOUR);
    w.verdict(
      5544,
      2,
      ['met', 'met', 'unmet', 'met', 'partial', 'met'],
      NOW - 5 * MINUTE,
    );
    w.envelope(5544, 'blocked', NOW - MINUTE, {
      blocked: { blockClass: 'acceptance-unmet' },
      nextCommand: 'node .agents/scripts/deliver-recover.js --story 5544',
    });
    await start($);
    const ui = await band($, 'terminal');
    expect(
      await textOf(ui, /needs you at check · acceptance-unmet$/),
    ).toBeDefined();
    expect(
      await textOf(
        ui,
        /^↳ node .agents\/scripts\/deliver-recover.js --story 5544 {3}AC-3, AC-5$/,
      ),
    ).toBeDefined();
  });

  for (const status of ['failed', 'escalated']) {
    test(`a ${status} result renders red as failed with its next command`, async ($, on) => {
      const w = world(on);
      w.dir('.agents');
      w.envelope(5544, status, NOW - MINUTE, {
        failure: { reason: 'push rejected' },
        nextCommand: 'node .agents/scripts/deliver-recover.js --story 5544',
      });
      await start($);
      const ui = await band($, 'terminal');
      const head = await ui.find({
        type: 'Text',
        text: /^✗ #5544 {3}failed at start · push rejected$/,
      });
      expect(head?.props.color).toBe('red');
      const next = await ui.find({
        type: 'Text',
        text: /^↳ node .agents\/scripts\/deliver-recover.js/,
      });
      expect(next?.props.color).toBe('red');
    });
  }

  test('red PR checks while merging render red with an Open PR link', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.json('.agentrc.json', { github: { owner: 'acme', repo: 'widgets' } });
    w.init(5544);
    w.envelope(5544, 'pending', NOW - MINUTE, {
      pr: { number: 5545, checksStatus: 'failure' },
    });
    await start($);
    const ui = await band($, 'terminal');
    const head = await ui.find({
      type: 'Text',
      text: /▰▰▰▰▰▰ merge · PR #5545 · checks failing/,
    });
    expect(head?.props.color).toBe('red');
    expect(
      (await ui.find({ type: 'Text', text: '↳ PR #5545 checks failing' }))
        ?.props.color,
    ).toBe('red');
    const link = await ui.find({ type: 'Link' });
    expect(link?.props.href).toBe('https://github.com/acme/widgets/pull/5545');
  });

  test('a landed result is one green line for 10 minutes, then the band clears', async ($, on) => {
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
        text: /^✓ #5540 Band v2 {3}landed in 5:39 · PR #5541 · 2 follow-ups$/,
      });
      expect(line?.props.color).toBe('green');
      expect(await textsOf(ui)).toHaveLength(1);
    }
    await w.clock.advance(10 * MINUTE);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /#5540/)).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
  });

  test('run chips always include the focus Story and drop the queued count', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.worktree(5543, NOW - 40 * MINUTE);
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
    const texts = await textsOf(ui);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^● #5544 .* {3}run 0\/3 {2}◐5543 ●5544 ○5545$/);
    expect(texts[0]).not.toMatch(/queued/);
  });

  test('a finished run with a Story that did not land shows the roll-up', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5543, 'landed', NOW - 30 * MINUTE, { elapsedSeconds: 600 });
    w.envelope(5544, 'landed', NOW - 20 * MINUTE, { elapsedSeconds: 600 });
    w.envelope(5545, 'blocked', NOW - 5 * MINUTE, {
      phase: 'confirm-merge',
      elapsedSeconds: 900,
    });
    w.json('temp/run-abc123/ledger.json', {
      kind: 'deliver-run-ledger',
      runId: 'abc123',
      stories: [5543, 5544, 5545],
      dispatched: [5543, 5544, 5545],
      updatedAt: new Date(NOW - 5 * MINUTE).toISOString(),
    });
    await start($);
    const ui = await band($, 'terminal');
    const line = await ui.find({
      type: 'Text',
      text: /^◆ run 2\/3 landed in 35:00 · #5545 needs you at confirm-merge {3}✓5543 ✓5544 ◆5545$/,
    });
    expect(line?.props.color).toBe('magenta');
  });

  test('Hide hides a healthy band, which comes back when the Story turns slow', async ($, on) => {
    const w = world(on);
    slowCloseStory(w);
    await start($);
    let ui = await band($, 'terminal');
    await ui.press({ key: 'hide' });
    ui = await band($, 'terminal');
    expect(await textOf(ui, /#5544/)).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
    await w.clock.advance(15 * SECOND);
    ui = await band($, 'terminal');
    expect(await textOf(ui, /#5544/)).toBeUndefined();
    await w.clock.advance(75 * SECOND);
    ui = await band($, 'terminal');
    expect(await textOf(ui, /^▲ #5544/)).toBeDefined();
  });

  test('build, check and handoff learn their usual time from Stories the band watched', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    await start($);
    for (const [index, minutes] of [3, 4, 5].entries()) {
      const id = 5600 + index;
      const begun = NOW - 30 * MINUTE;
      w.worktree(id, NOW + index * MINUTE);
      w.init(id, begun);
      w.commits(id, [{ subject: 'feat: x', at: begun + MINUTE }]);
      await w.clock.advance(15 * SECOND);
      w.verdict(id, 1, ['met'], begun + (1 + minutes) * MINUTE);
      await w.clock.advance(15 * SECOND);
    }
    w.worktree(5700, NOW + 10 * MINUTE);
    w.init(5700, NOW - 2 * MINUTE);
    w.commits(5700, [{ subject: 'feat: y', at: NOW }]);
    await w.clock.advance(15 * SECOND);
    const ui = await band($, 'terminal');
    expect(
      await textOf(
        ui,
        /^● #5700 .*▰▰▱▱▱▱ build · 1 commit {3}\d+:\d\d \/ ~4:00$/,
      ),
    ).toBeDefined();
  });

  test('under 80 body columns a healthy band drops the title; an attention band keeps line 2', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.init(5544);
    w.worktree(5544);
    await start($);
    let ui = await band($, 'terminal', 79);
    expect(await textsOf(ui)).toEqual(['● #5544   ▰▱▱▱▱▱ start   30:00']);
    w.envelope(5544, 'blocked', NOW + MINUTE, {
      blocked: { blockClass: 'checks-failed' },
      nextCommand: 'node x.js',
    });
    await w.clock.advance(15 * SECOND);
    ui = await band($, 'terminal', 79);
    expect(await textsOf(ui)).toEqual([
      '◆ #5544   needs you at start · checks-failed',
      '↳ node x.js',
    ]);
  });

  test('long text is cut short with an ellipsis, never wrapped', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5544, 'blocked', NOW - MINUTE, {
      blocked: { blockClass: 'x'.repeat(300) },
      nextCommand: `node ${'y'.repeat(300)}`,
    });
    await start($);
    const ui = await band($, 'terminal', 100);
    const [first, second] = await textsOf(ui);
    expect(first?.length).toBe(82);
    expect(first?.endsWith('…')).toBe(true);
    expect(second?.length).toBe(82);
    expect(second?.endsWith('…')).toBe(true);
  });

  test('the Details pane leads with what needs attention, then the timeline', async ($, on) => {
    const w = world(on);
    slowCloseStory(w);
    await start($);
    const ui = await band($, 'terminal');
    await ui.press({ key: 'details' });
    expect(w.state.opened).toEqual(['mandrel-status']);
    const details = await pane($);
    let rows = await textsOf(details);
    expect(rows[0]).toMatch(/^#5544 Band v2 {3}in flight · /);
    expect(rows).not.toContain('NEEDS ATTENTION');
    expect(rows).toContain('TIMELINE');
    await w.clock.advance(90 * SECOND);
    rows = await textsOf(details);
    const attention = rows.indexOf('NEEDS ATTENTION');
    expect(attention).toBeGreaterThan(0);
    expect(attention).toBeLessThan(rows.indexOf('TIMELINE'));
    expect(rows[attention + 1]).toMatch(
      /^ {2}▲ close-validation {3}3:30 {3}usual ~1:30 {3}2\.3× {3}gate log quiet 1m$/,
    );
    expect(rows.some((row) => /^ {2}✓ start /.test(row))).toBe(true);
    expect(rows.some((row) => /^ {2}▲ close /.test(row))).toBe(true);
    expect(rows.some((row) => /^ {6}confirm-merge .*~6:40$/.test(row))).toBe(
      true,
    );
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
      await textOf(ui, /^✓ #5540 {3}landed in 5:39 · PR #5541$/),
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
    expect(await textOf(ui, /#55/)).toBeUndefined();
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
  });

  test('draws nothing with no in-flight Story and no recent result', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.envelope(5540, 'landed', NOW - 3 * HOUR);
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /#5540/)).toBeUndefined();
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
    expect(await textOf(ui, /#5540/)).toBeUndefined();
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
    expect(await textOf(ui, /^◆ #7 {3}needs you/)).toBeDefined();
    expect(await textOf(ui, /#1 /)).toBeUndefined();
  });

  test('tempRoot defaults to temp when no config sets it', async ($, on) => {
    const w = world(on);
    w.dir('.agents');
    w.json('.agentrc.json', { project: {} });
    w.envelope(5540, 'landed');
    await start($);
    const ui = await band($, 'terminal');
    expect(await textOf(ui, /^✓ #5540 {3}landed/)).toBeDefined();
  });
});
