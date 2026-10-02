// mandrel-status — a beta, read-only Claude Code mod. It reads the state files
// /mandrel-deliver already writes and draws a short band above the prompt, plus
// a Details pane. Nothing in Mandrel depends on it; see
// .agents/docs/runbooks/mods.md.

import type { EngineInterface, FsEntry, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';

import type {
  Focus,
  Learned,
  PhaseRow,
  RunLine,
  Snapshot,
  StageName,
  StageRow,
} from '../types';

const REFRESH_MS = 15_000;
const LEARN_MS = 10 * 60_000;
const STALL_MS = 10 * 60_000;
const MIN_STALL_MS = 2 * 60_000;
const RECENT_MS = 2 * 60 * 60_000;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 30;
/** Under this many body columns the band keeps only its first line. */
const NARROW = 80;
/** Cells the Hide and Details buttons take at the end of line 1. */
const BUTTON_CELLS = 18;
const PANE = 'mandrel-status';

const STAGES: StageName[] = [
  'start',
  'build',
  'check',
  'handoff',
  'close',
  'merge',
];
const CLOSE_PHASES = [
  'wrong-tree-guard',
  'base-sync',
  'close-validation',
  'push',
  'pull-request',
  'code-review',
  'auto-merge',
  'confirm-merge',
  'post-land',
];
const MERGE_PHASES = new Set(['auto-merge', 'confirm-merge']);
const STOPPED = new Set(['blocked', 'failed', 'escalated']);
const ANNOUNCED = new Set(['landed', 'blocked']);

const WORKTREE = /^story-(\d+)$/;
const ENVELOPE = /^story-deliver-terminal-(\d+)\.json$/;
const VERDICT = /^acceptance-verdict-round-(\d+)\.json$/;
const RUN_DIR = /^run-[\w-]+$/;
const GITDIR = /^gitdir:\s*(.+?)\s*$/m;
const MAIN_OF = /^(.+)\/\.git\/worktrees\/[^/]+$/;
const INIT_MARKER = '--- STORY INIT RESULT ---';
const TITLE = /"storyTitle"\s*:\s*("(?:[^"\\]|\\.)*")/;
const GATE = /^\[([^\]]+)\]/;
const REFLOG_TIME = /\s(\d+)\s[+-]\d{4}$/;
const BULLET = /^\s*[-*]\s+\S/;

const EMPTY: Snapshot = { focus: null, run: null, scannedAt: 0 };
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
const learnedAtom = atom(
  { plugin: 'mandrel-status', key: 'learned' } as const,
  { at: 0, phases: {} } as Learned,
);
const hiddenFor = atom(
  { plugin: 'mandrel-status', key: 'hiddenFor' } as const,
  null as number | null,
);

type Stamped = { storyId: number; mtimeMs: number };

/** Where a scan reads: the main checkout, its tempRoot, the orchestration listing. */
type Ctx = {
  root: string;
  temp: string;
  orchestration: string;
  files: FsEntry[];
  now: number;
};

type Envelope = {
  storyId: number;
  at: number;
  status: string;
  prNumber: number | null;
  checksStatus: string | null;
  elapsedSeconds: number | null;
  phaseDurations: Record<string, number>;
  problem: string | null;
  nextCommand: string | null;
};

type Progress = {
  stage: string;
  phase: string | null;
  stageStartedAt: number | null;
  phaseStartedAt: number | null;
  prNumber: number | null;
  updatedAt: number;
};

type Commits = { at: number; firstAt: number; count: number; subject: string };
type Verdict = {
  at: number;
  firstAt: number;
  round: number;
  met: number;
  total: number;
};
type Handoff = {
  at: number;
  firstAt: number;
  step: string | null;
  steps: { name: string; at: number }[];
  doneAt: number | null;
};

/** Everything on disk about one Story, each piece stamped with its time. */
type Evidence = {
  init: { at: number; title: string | null } | null;
  build: Commits | null;
  check: Verdict | null;
  handoff: Handoff | null;
  close: { at: number; gate: string | null } | null;
  progress: Progress | null;
  envelope: Envelope | null;
  followUps: number | null;
};

// ---------------------------------------------------------------- reading

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** An epoch-ms number or an ISO string, as the progress file and ledger write them. */
function toMs(value: unknown): number | null {
  if (typeof value === 'number') return num(value);
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

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

function tempRootOf(config: unknown): string | undefined {
  const value = (config as { project?: { paths?: { tempRoot?: unknown } } })
    ?.project?.paths?.tempRoot;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `.agentrc.local.json` wins over `.agentrc.json`; `temp` when neither sets it. */
async function resolveTempRoot(
  $: EngineInterface,
  root: string,
): Promise<string> {
  const temp =
    tempRootOf(await readJson($, join(root, '.agentrc.local.json'))) ??
    tempRootOf(await readJson($, join(root, '.agentrc.json'))) ??
    'temp';
  return join(root, temp);
}

async function listMatching(
  $: EngineInterface,
  dir: string,
  pattern: RegExp,
): Promise<Stamped[]> {
  const entries = await $.fs.list(dir).catch(() => []);
  const found: Stamped[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (!match || entry.kind !== 'dir') continue;
    const mtimeMs = await $.fs
      .stat(`${dir}/${entry.name}`)
      .then((stat) => stat.mtimeMs)
      .catch(() => 0);
    found.push({ storyId: Number(match[1]), mtimeMs });
  }
  return found;
}

function stampFiles(files: FsEntry[], pattern: RegExp): Stamped[] {
  return files.flatMap((entry) => {
    const match = pattern.exec(entry.name);
    return match && entry.kind === 'file'
      ? [{ storyId: Number(match[1]), mtimeMs: entry.mtimeMs }]
      : [];
  });
}

const fileNamed = (ctx: Ctx, name: string): FsEntry | undefined =>
  ctx.files.find((entry) => entry.name === name && entry.kind === 'file');

const newest = (list: Stamped[]): Stamped | undefined =>
  [...list].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

function toEnvelope(
  storyId: number,
  at: number,
  raw: unknown,
): Envelope | null {
  const body = raw as {
    status?: unknown;
    elapsedSeconds?: unknown;
    nextCommand?: unknown;
    phaseDurations?: unknown;
    pr?: { number?: unknown; checksStatus?: unknown } | null;
    blocked?: { blockClass?: unknown } | null;
    failure?: { reason?: unknown } | null;
  };
  const status = str(body?.status);
  if (status === null) return null;
  const pr = body.pr ?? {};
  return {
    storyId,
    at,
    status,
    prNumber: num(pr.number),
    checksStatus: str(pr.checksStatus),
    elapsedSeconds: num(body.elapsedSeconds),
    phaseDurations: durationsOf(body.phaseDurations),
    problem: str(body.blocked?.blockClass) ?? str(body.failure?.reason),
    nextCommand: str(body.nextCommand),
  };
}

function durationsOf(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (pair): pair is [string, number] => num(pair[1]) !== null && pair[1] >= 0,
    ),
  );
}

async function readEnvelope(
  $: EngineInterface,
  ctx: Ctx,
  stamp: Stamped,
): Promise<Envelope | null> {
  const raw = await readJson(
    $,
    `${ctx.orchestration}/story-deliver-terminal-${stamp.storyId}.json`,
  );
  return toEnvelope(stamp.storyId, stamp.mtimeMs, raw);
}

async function readInit(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<Evidence['init']> {
  const entry = fileNamed(ctx, `story-init-result-${id}.log`);
  if (!entry) return null;
  const text = (await readText($, `${ctx.orchestration}/${entry.name}`)) ?? '';
  const body = text.slice(Math.max(0, text.indexOf(INIT_MARKER)));
  const quoted = TITLE.exec(body)?.[1];
  let title: string | null = null;
  try {
    title = quoted ? str(JSON.parse(quoted)) : null;
  } catch {
    title = null;
  }
  return { at: entry.mtimeMs, title };
}

/** The `commit…` lines of a reflog: count, last subject, first and last time. */
function parseReflog(text: string): Commits | null {
  const commits = text.split('\n').flatMap((line) => {
    const tab = line.indexOf('\t');
    const message = tab < 0 ? '' : line.slice(tab + 1);
    if (!message.startsWith('commit')) return [];
    const seconds = Number(REFLOG_TIME.exec(line.slice(0, tab))?.[1]);
    return [
      {
        subject: message.replace(/^commit[^:]*:\s*/, ''),
        at: Number.isFinite(seconds) ? seconds * 1000 : 0,
      },
    ];
  });
  const last = commits.at(-1);
  if (!last) return null;
  return {
    at: last.at,
    firstAt: commits[0].at,
    count: commits.length,
    subject: last.subject,
  };
}

async function readBuild(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<Commits | null> {
  const pointer = await readText(
    $,
    join(ctx.root, `.worktrees/story-${id}/.git`),
  );
  const gitdir =
    GITDIR.exec(pointer ?? '')?.[1] ??
    join(ctx.root, `.git/worktrees/story-${id}`);
  const reflog = await readText($, `${gitdir}/logs/HEAD`);
  return reflog === null ? null : parseReflog(reflog);
}

async function readCheck(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<Verdict | null> {
  const dir = `${ctx.temp}/scratch/story-${id}`;
  const rounds = (await $.fs.list(dir).catch(() => [])).flatMap((entry) => {
    const match = VERDICT.exec(entry.name);
    return match && entry.kind === 'file'
      ? [{ round: Number(match[1]), entry }]
      : [];
  });
  if (rounds.length === 0) return null;
  const last = rounds.reduce((a, b) => (b.round > a.round ? b : a));
  const raw = (await readJson($, `${dir}/${last.entry.name}`)) as {
    criteria?: { verdict?: unknown }[];
  };
  const criteria = Array.isArray(raw?.criteria) ? raw.criteria : [];
  return {
    at: last.entry.mtimeMs,
    firstAt: Math.min(...rounds.map((one) => one.entry.mtimeMs)),
    round: last.round,
    met: criteria.filter((one) => one?.verdict === 'met').length,
    total: criteria.length,
  };
}

function readHandoff(ctx: Ctx, id: number): Handoff | null {
  const prefix = `story-handoff-${id}-`;
  const steps = ctx.files
    .filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith('.log'),
    )
    .map((entry) => ({
      name: entry.name.slice(prefix.length, -'.log'.length),
      at: entry.mtimeMs,
    }))
    .sort((a, b) => a.at - b.at);
  const doneAt = fileNamed(ctx, `story-handoff-${id}.json`)?.mtimeMs ?? null;
  const times = [...steps.map((one) => one.at), doneAt ?? 0];
  if (steps.length === 0 && doneAt === null) return null;
  return {
    at: Math.max(...times),
    firstAt: steps[0]?.at ?? doneAt ?? 0,
    step: steps.at(-1)?.name ?? null,
    steps,
    doneAt,
  };
}

async function readClose(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<Evidence['close']> {
  const entry = fileNamed(ctx, `close-gates-${id}.log`);
  if (!entry) return null;
  const text = (await readText($, `${ctx.orchestration}/${entry.name}`)) ?? '';
  const last = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .at(-1);
  return { at: entry.mtimeMs, gate: GATE.exec(last ?? '')?.[1] ?? null };
}

/** The sibling Story's progress file; read when present, never required. */
async function readProgress(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<Progress | null> {
  if (!fileNamed(ctx, `story-progress-${id}.json`)) return null;
  const raw = (await readJson(
    $,
    `${ctx.orchestration}/story-progress-${id}.json`,
  )) as Record<string, unknown> | undefined;
  const updatedAt = toMs(raw?.updatedAt);
  const stage = str(raw?.stage);
  if (raw?.kind !== 'story-progress' || updatedAt === null || stage === null)
    return null;
  return {
    stage,
    phase: str(raw.phase),
    stageStartedAt: toMs(raw.stageStartedAt),
    phaseStartedAt: toMs(raw.phaseStartedAt),
    prNumber: num(raw.prNumber),
    updatedAt,
  };
}

async function readFollowUps(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
): Promise<number | null> {
  const name = `follow-ups-rollup-${id}.md`;
  if (!fileNamed(ctx, name)) return null;
  const text = await readText($, `${ctx.orchestration}/${name}`);
  return text === null
    ? null
    : text.split('\n').filter((line) => BULLET.test(line)).length;
}

async function gather(
  $: EngineInterface,
  ctx: Ctx,
  id: number,
  envelope: Envelope | null,
): Promise<Evidence> {
  const [init, build, check, close, progress, followUps] = await Promise.all([
    readInit($, ctx, id),
    readBuild($, ctx, id),
    readCheck($, ctx, id),
    readClose($, ctx, id),
    readProgress($, ctx, id),
    readFollowUps($, ctx, id),
  ]);
  return {
    init,
    build,
    check,
    handoff: readHandoff(ctx, id),
    close,
    progress,
    envelope,
    followUps,
  };
}

// --------------------------------------------------------------- learning

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Medians of each close phase over the newest 30 envelopes; at most every 10 minutes. */
async function learn(
  $: EngineInterface,
  ctx: Ctx,
  envelopes: Stamped[],
): Promise<Learned> {
  const held = await read($, learnedAtom);
  if (held.at > 0 && ctx.now - held.at < LEARN_MS) return held;
  const samples: Record<string, number[]> = {};
  const recent = [...envelopes]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SAMPLES);
  for (const stamp of recent) {
    const envelope = await readEnvelope($, ctx, stamp);
    for (const [name, seconds] of Object.entries(
      envelope?.phaseDurations ?? {},
    )) {
      samples[name] = [...(samples[name] ?? []), seconds];
    }
  }
  const phases = Object.fromEntries(
    Object.entries(samples).map(([name, list]) => [
      name,
      { medianSeconds: median(list), samples: list.length },
    ]),
  );
  const next: Learned = { at: ctx.now, phases };
  await update($, learnedAtom, () => next);
  return next;
}

// ---------------------------------------------------------------- deriving

function stageTimes(ev: Evidence): Partial<Record<StageName, number>> {
  const handoff = ev.handoff
    ? Math.max(ev.handoff.at, ev.handoff.doneAt ?? 0)
    : undefined;
  return {
    start: ev.init?.at,
    build: ev.build?.at,
    check: ev.check?.at,
    handoff,
    close: ev.close?.at,
    merge: ev.envelope?.status === 'pending' ? ev.envelope.at : undefined,
  };
}

/**
 * The current stage: the furthest one with evidence, back to build when a
 * commit follows the last verdict round; a progress file newer than every
 * other piece of evidence decides instead.
 */
function pickStage(ev: Evidence): {
  stage: StageName;
  progress: Progress | null;
} {
  const times = stageTimes(ev);
  let stage: StageName = 'start';
  for (const name of STAGES) if (times[name] !== undefined) stage = name;
  if (stage === 'check' && (times.build ?? 0) > (times.check ?? 0))
    stage = 'build';
  const latest = Math.max(0, ...Object.values(times).map((at) => at ?? 0));
  const progress =
    ev.progress && ev.progress.updatedAt >= latest ? ev.progress : null;
  if (progress?.phase && MERGE_PHASES.has(progress.phase))
    return { stage: 'merge', progress };
  if (progress?.stage === 'handoff' || progress?.stage === 'close')
    return { stage: progress.stage, progress };
  return { stage, progress: null };
}

function stageStarts(ev: Evidence): Record<StageName, number | null> {
  const known = ev.progress;
  const mergeStart =
    known?.phase && MERGE_PHASES.has(known.phase) ? known.phaseStartedAt : null;
  return {
    start: ev.init?.at ?? null,
    build: ev.build?.firstAt ?? null,
    check: ev.check?.firstAt ?? null,
    handoff: ev.handoff?.firstAt ?? null,
    close:
      (known?.stage === 'close' ? known.stageStartedAt : null) ??
      ev.handoff?.doneAt ??
      ev.close?.at ??
      null,
    merge:
      mergeStart ?? (ev.envelope?.status === 'pending' ? ev.envelope.at : null),
  };
}

function stageRows(ev: Evidence, current: StageName): StageRow[] {
  const starts = stageStarts(ev);
  const at = STAGES.indexOf(current);
  return STAGES.map((name, index) => {
    const later = STAGES.slice(index + 1, at + 1)
      .map((next) => starts[next])
      .find((value) => value !== null);
    return {
      name,
      startedAt: index <= at ? starts[name] : null,
      endedAt: index < at ? (later ?? null) : null,
    };
  });
}

/** The close phase the band times, when the stage has one. */
function phaseOf(stage: StageName, progress: Progress | null): string | null {
  if (stage === 'close') return progress?.phase ?? 'close-validation';
  if (stage === 'merge') return progress?.phase ?? 'confirm-merge';
  return null;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

function detailOf(
  stage: StageName,
  ev: Evidence,
  progress: Progress | null,
  prNumber: number | null,
): string {
  switch (stage) {
    case 'start':
      return 'initialized';
    case 'build':
      return ev.build
        ? `${plural(ev.build.count, 'commit')} · ${ev.build.subject}`
        : 'building';
    case 'check':
      return ev.check
        ? `round ${ev.check.round} · ${ev.check.met}/${ev.check.total} met`
        : 'self-eval';
    case 'handoff':
      if (progress?.phase) return `step ${progress.phase}`;
      if (ev.handoff?.doneAt && !progress) return 'handed off';
      return `step ${ev.handoff?.step ?? 'starting'}`;
    case 'close': {
      const phase = progress?.phase ?? 'close-validation';
      const gate = ev.close?.gate;
      return phase === 'close-validation' && gate
        ? `gate ${gate}`
        : `phase ${phase}`;
    }
    case 'merge': {
      const pr = prNumber === null ? 'PR' : `PR #${prNumber}`;
      return `${pr} · ${progress?.phase ?? 'waiting on merge'}`;
    }
  }
}

/** The stall verdict: learned medians first, else the 10-minute gate-log rule. */
function stallOf(
  stage: StageName,
  ev: Evidence,
  elapsedMs: number | null,
  usualMs: number | null,
  now: number,
): { isStalled: boolean; idleMinutes: number | null } {
  if (usualMs !== null && elapsedMs !== null)
    return {
      isStalled: elapsedMs > Math.max(2 * usualMs, MIN_STALL_MS),
      idleMinutes: null,
    };
  const idleMs = stage === 'close' && ev.close ? now - ev.close.at : 0;
  return idleMs > STALL_MS
    ? { isStalled: true, idleMinutes: Math.floor(idleMs / 60_000) }
    : { isStalled: false, idleMinutes: null };
}

function deriveFocus(
  storyId: number,
  ev: Evidence,
  learned: Learned,
  now: number,
): Focus {
  const isInFlight = ev.envelope === null;
  const { stage, progress } = pickStage(ev);
  const phase = phaseOf(stage, progress);
  const learnedPhase = phase ? learned.phases[phase] : undefined;
  const usualMs =
    learnedPhase && learnedPhase.samples >= MIN_SAMPLES
      ? learnedPhase.medianSeconds * 1000
      : null;
  const phaseStart = progress?.phaseStartedAt ?? stageStarts(ev)[stage];
  const phaseElapsedMs =
    isInFlight && phaseStart !== null ? Math.max(0, now - phaseStart) : null;
  const stall = isInFlight
    ? stallOf(stage, ev, phaseElapsedMs, usualMs, now)
    : { isStalled: false, idleMinutes: null };
  const prNumber = ev.progress?.prNumber ?? ev.envelope?.prNumber ?? null;
  const closePhases: PhaseRow[] = CLOSE_PHASES.map((name) => ({
    name,
    seconds: ev.envelope?.phaseDurations[name] ?? null,
    usualSeconds: learned.phases[name]?.medianSeconds ?? null,
  }));
  return {
    storyId,
    title: ev.init?.title ?? null,
    status: ev.envelope?.status ?? 'in-flight',
    stage,
    detail: detailOf(stage, ev, progress, prNumber),
    stages: stageRows(ev, stage),
    handoffSteps: ev.handoff?.steps ?? [],
    closePhases,
    prNumber,
    checksStatus: ev.envelope?.checksStatus ?? null,
    elapsedSeconds: ev.envelope?.elapsedSeconds ?? null,
    phaseElapsedMs,
    usualMs,
    isStalled: stall.isStalled,
    idleMinutes: stall.idleMinutes,
    problem: ev.envelope?.problem ?? null,
    nextCommand: ev.envelope?.nextCommand ?? null,
    followUps: ev.followUps,
  };
}

/** A Story whose worktree exists with no newer terminal envelope; the newest. */
function pickInFlight(
  worktrees: Stamped[],
  envelopes: Stamped[],
): Stamped | undefined {
  return newest(
    worktrees.filter((tree) => {
      const envelope = envelopes.find((one) => one.storyId === tree.storyId);
      return !envelope || envelope.mtimeMs < tree.mtimeMs;
    }),
  );
}

type Ledger = { stories: number[]; dispatched: number[]; updatedAt: number };

function toLedger(raw: unknown): Ledger | null {
  const body = raw as Record<string, unknown> | undefined;
  const ids = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((id) => num(id) !== null) : [];
  const updatedAt = toMs(body?.updatedAt);
  if (body?.kind !== 'deliver-run-ledger' || updatedAt === null) return null;
  return {
    stories: ids(body.stories),
    dispatched: ids(body.dispatched),
    updatedAt,
  };
}

async function readLedgers($: EngineInterface, ctx: Ctx): Promise<Ledger[]> {
  const entries = await $.fs.list(ctx.temp).catch(() => []);
  const ledgers: Ledger[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !RUN_DIR.test(entry.name)) continue;
    const ledger = toLedger(
      await readJson($, `${ctx.temp}/${entry.name}/ledger.json`),
    );
    if (ledger && ctx.now - ledger.updatedAt <= RECENT_MS) ledgers.push(ledger);
  }
  return ledgers.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The newest live run ledger with a Story still to land. */
async function readRun(
  $: EngineInterface,
  ctx: Ctx,
  envelopes: Stamped[],
  focus: Focus | null,
): Promise<RunLine | null> {
  for (const ledger of await readLedgers($, ctx)) {
    const statuses = new Map<number, string>();
    for (const stamp of envelopes.filter((one) =>
      ledger.stories.includes(one.storyId),
    )) {
      const envelope = await readEnvelope($, ctx, stamp);
      if (envelope) statuses.set(stamp.storyId, envelope.status);
    }
    const open = ledger.stories.filter((id) => statuses.get(id) !== 'landed');
    if (open.length === 0) continue;
    const currentId =
      focus && open.includes(focus.storyId)
        ? focus.storyId
        : open.find((id) => ledger.dispatched.includes(id));
    const stageOf = (id: number): string =>
      id === focus?.storyId
        ? focus.status === 'in-flight'
          ? focus.stage
          : focus.status
        : (statuses.get(id) ?? 'dispatched');
    return {
      landed: ledger.stories.length - open.length,
      total: ledger.stories.length,
      current:
        currentId === undefined
          ? null
          : { storyId: currentId, stage: stageOf(currentId) },
      queued: ledger.stories.filter((id) => !ledger.dispatched.includes(id))
        .length,
    };
  }
  return null;
}

async function scan(
  $: EngineInterface,
): Promise<{ next: Snapshot; latest: Envelope | null }> {
  const root = await resolveRoot($);
  if (!(await $.fs.exists(join(root, '.agents')).catch(() => false)))
    return { next: EMPTY, latest: null };
  const temp = await resolveTempRoot($, root);
  const orchestration = `${temp}/orchestration`;
  const now = await $.clock.now();
  const [worktrees, files] = await Promise.all([
    listMatching($, join(root, '.worktrees'), WORKTREE),
    $.fs.list(orchestration).catch(() => []),
  ]);
  const ctx: Ctx = { root, temp, orchestration, files, now };
  const envelopes = stampFiles(files, ENVELOPE);
  const learned = await learn($, ctx, envelopes);
  const recent = newest(
    envelopes.filter((one) => now - one.mtimeMs <= RECENT_MS),
  );
  const latest = recent ? await readEnvelope($, ctx, recent) : null;
  const inFlight = pickInFlight(worktrees, envelopes);
  const focusId = inFlight?.storyId ?? latest?.storyId;
  const focus =
    focusId === undefined
      ? null
      : deriveFocus(
          focusId,
          await gather($, ctx, focusId, inFlight ? null : latest),
          learned,
          now,
        );
  const run = await readRun($, ctx, envelopes, focus);
  return { next: { focus, run, scannedAt: now }, latest };
}

/** Toasts a landed or blocked result once; the first scan only records. */
async function announce(
  $: EngineInterface,
  latest: Envelope | null,
): Promise<void> {
  const seeded = await read($, isSeeded);
  if (!seeded) await update($, isSeeded, () => true);
  if (!latest) return;
  const key = `${latest.storyId}:${latest.at}`;
  if ((await read($, seen)).includes(key)) return;
  await update($, seen, (list) => [...list, key].slice(-50));
  if (seeded && ANNOUNCED.has(latest.status)) {
    const pr = latest.prNumber ? ` (PR #${latest.prNumber})` : '';
    $.ui.toast(`Story #${latest.storyId} ${latest.status}${pr}`);
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const { next, latest } = await scan($);
    await update($, snapshot, () => next);
    await announce($, latest);
  } catch {
    // Read-only and best effort: a failed scan leaves the last drawing up.
  }
}

// --------------------------------------------------------------- drawing

type Line = { text: string; color: string | null };

/** `45s`, `5m39s`, `1h05m`. */
function fmt(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Cut short with an ellipsis, never wrapped. */
function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? '…' : `${text.slice(0, width - 1)}…`;
}

function colorOf(focus: Focus): string | null {
  if (focus.status === 'landed') return 'green';
  if (STOPPED.has(focus.status)) return 'red';
  return focus.isStalled ? 'yellow' : null;
}

function rightOf(focus: Focus): string {
  const pr = focus.prNumber === null ? null : `PR #${focus.prNumber}`;
  if (focus.status === 'landed') {
    return [
      `landed in ${focus.elapsedSeconds === null ? '?' : fmt(focus.elapsedSeconds * 1000)}`,
      pr,
      focus.followUps === null ? null : plural(focus.followUps, 'follow-up'),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (STOPPED.has(focus.status))
    return [`${focus.status}: ${focus.problem ?? 'see the Story'}`, pr]
      .filter(Boolean)
      .join(' · ');
  const checks = focus.checksStatus ? ` checks ${focus.checksStatus}` : '';
  return pr ? `${pr}${checks}` : '';
}

/** Line 1: outcome glyph, Story and title on the left, the outcome or PR on the right. */
function headline(focus: Focus, width: number): string {
  const glyph =
    focus.status === 'landed' ? '✓ ' : STOPPED.has(focus.status) ? '✗ ' : '';
  const left = `${glyph}mandrel · #${focus.storyId}${focus.title ? ` ${focus.title}` : ''}`;
  const right = cut(rightOf(focus), Math.max(16, Math.floor(width * 0.6)));
  if (!right) return cut(left, width);
  const room = Math.max(glyph.length + 14, width - right.length - 3);
  return cut(`${cut(left, room)} · ${right}`, width);
}

function timingOf(focus: Focus): string {
  if (focus.phaseElapsedMs === null) return focus.status;
  const usual =
    focus.usualMs === null ? '' : ` of usual ~${fmt(focus.usualMs)}`;
  const stall = !focus.isStalled
    ? ''
    : focus.idleMinutes === null
      ? ' · stalled?'
      : ` · stalled? no gate output for ${focus.idleMinutes}m`;
  return `${fmt(focus.phaseElapsedMs)}${usual}${stall}`;
}

/** Line 2: the six-stage strip, the step detail and the timing; or the next command. */
function strip(focus: Focus): string {
  if (STOPPED.has(focus.status))
    return `next: ${focus.nextCommand ?? 'see the Story for how to resume'}`;
  const at = STAGES.indexOf(focus.stage);
  const marks = STAGES.map((name, index) => {
    const mark = index < at ? '✓' : index === at ? '●' : '○';
    return `${mark} ${name}`;
  }).join(' ─ ');
  return `${marks} · ${focus.detail} · ${timingOf(focus)}`;
}

function runText(run: RunLine): string {
  const current = run.current
    ? ` · #${run.current.storyId} ${run.current.stage}`
    : '';
  return `run ${run.landed}/${run.total} landed${current} · ${run.queued} queued`;
}

/** The band's lines for a body this wide; null draws nothing. */
function compose({ focus, run }: Snapshot, columns: number): Line[] | null {
  if (!focus) return null;
  const color = colorOf(focus);
  const lines: Line[] = [
    { text: headline(focus, Math.max(20, columns - BUTTON_CELLS)), color },
  ];
  if (columns < NARROW) return lines;
  if (focus.status !== 'landed')
    lines.push({ text: cut(strip(focus), columns), color });
  if (run) lines.push({ text: cut(runText(run), columns), color: null });
  return lines;
}

const clockOf = (ms: number | null): string => {
  if (ms === null) return '—';
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
};

/** The Details pane: stages with start and duration, handoff steps, close phases. */
function details(focus: Focus | null, now: number): string[] {
  if (!focus) return ['No /mandrel-deliver Story in flight or recent.'];
  const at = STAGES.indexOf(focus.stage);
  const stages = focus.stages.map((row, index) => {
    const mark = index < at ? '✓' : index === at ? '●' : '○';
    const end = row.endedAt ?? (index === at ? now : null);
    const took =
      row.startedAt !== null && end !== null ? fmt(end - row.startedAt) : '—';
    return `  ${mark} ${row.name.padEnd(8)} ${clockOf(row.startedAt)}  ${took}`;
  });
  const steps = focus.handoffSteps.length
    ? focus.handoffSteps.map((step) => `  ${step.name}  ${clockOf(step.at)}`)
    : ['  none yet'];
  const phases = focus.closePhases.map((phase) => {
    const took = phase.seconds === null ? '—' : fmt(phase.seconds * 1000);
    const usual =
      phase.usualSeconds === null
        ? ''
        : ` (usual ~${fmt(phase.usualSeconds * 1000)})`;
    return `  ${phase.name.padEnd(17)} ${took}${usual}`;
  });
  return [
    `Story #${focus.storyId}${focus.title ? ` ${focus.title}` : ''} · ${focus.status}`,
    'Stages',
    ...stages,
    'Handoff steps',
    ...steps,
    'Close phases',
    ...phases,
  ];
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
    const current = await read($, snapshot);
    const lines = compose(current, e.props.bodyColumns);
    const focus = current.focus;
    if (!lines || !focus || (await read($, hiddenFor)) === focus.storyId)
      return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const [first, ...rest] = lines;
    const style = (line: Line) =>
      line.color ? { color: line.color } : { dimColor: true };
    return (
      <Box flexDirection="column">
        <Box>
          <Text {...style(first)} wrap="truncate">
            {first.text}
          </Text>
          <Button
            key="hide"
            label="Hide"
            onPress={() => update($, hiddenFor, () => focus.storyId)}
          />
          <Button
            key="details"
            label="Details"
            onPress={() => $.ui.open({ id: PANE, title: 'mandrel-status' })}
          />
        </Box>
        {rest.map((line, index) => (
          <Text key={`line-${index}`} {...style(line)} wrap="truncate">
            {line.text}
          </Text>
        ))}
      </Box>
    );
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const current = await read($, snapshot);
    return (
      <Box flexDirection="column">
        {details(current.focus, current.scannedAt).map((line, index) => (
          <Text key={`row-${index}`} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    );
  });
};
