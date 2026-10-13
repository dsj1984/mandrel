// mandrel-status — a beta, read-only Claude Code mod. It reads the state files
// /mandrel-deliver already writes and draws a short band above the prompt, plus
// a Details pane. Nothing in Mandrel depends on it; see
// .agents/docs/runbooks/mods.md.

import type { EngineInterface, FsEntry, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';

import type {
  Attention,
  ChipState,
  Focus,
  Learned,
  PhaseRow,
  RunLine,
  Snapshot,
  StageName,
  StageRow,
  Tracked,
} from '../types';

const REFRESH_MS = 15_000;
const LEARN_MS = 10 * 60_000;
const STALL_MS = 10 * 60_000;
const MIN_STALL_MS = 2 * 60_000;
/** How long a run ledger, or a result that did not land, stays on the band. */
const RECENT_MS = 2 * 60 * 60_000;
/** How long a landed result stays on the band. */
const LANDED_MS = 10 * 60_000;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 30;
/** Under this many body columns the band keeps only its first line. */
const NARROW = 80;
/** Cells the Hide and Details buttons take at the end of line 1. */
const BUTTON_CELLS = 18;
/** Cells the Copy button and the Open PR link take at the end of line 2. */
const ACTION_CELLS = 18;
/** The title's share of line 1. */
const TITLE_CELLS = 30;
/** Unmet acceptance ids named before `+N`. */
const MAX_UNMET = 4;
/** The longest bar in the Details pane. */
const BAR_CELLS = 16;
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
/** Stages the mod times itself; close and merge come from envelope phases. */
const LEARNED_STAGES = new Set<StageName>([
  'start',
  'build',
  'check',
  'handoff',
]);
const FAILED = new Set(['failed', 'escalated']);
const TERMINAL = new Set(['landed', 'blocked', 'failed', 'escalated']);

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
const stageSamples = atom(
  { plugin: 'mandrel-status', key: 'stageSamples' } as const,
  {} as Partial<Record<StageName, number[]>>,
);
const tracked = atom(
  { plugin: 'mandrel-status', key: 'tracked' } as const,
  null as Tracked | null,
);
const hiddenFor = atom(
  { plugin: 'mandrel-status', key: 'hiddenFor' } as const,
  null as string | null,
);

type Stamped = { storyId: number; mtimeMs: number };

/** Where a scan reads: the main checkout, its tempRoot, the orchestration listing. */
type Ctx = {
  root: string;
  temp: string;
  orchestration: string;
  files: FsEntry[];
  now: number;
  /** `https://github.com/<owner>/<repo>` from the merged config, when it names both. */
  repoUrl: string | null;
};

type Envelope = {
  storyId: number;
  at: number;
  status: string;
  /** Where the delivery stopped, as the envelope's `phase` names it. */
  phase: string | null;
  prNumber: number | null;
  prUrl: string | null;
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
  /** 1-based ids of the criteria not `met`. */
  unmet: number[];
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
    phase?: unknown;
    elapsedSeconds?: unknown;
    nextCommand?: unknown;
    phaseDurations?: unknown;
    pr?: { number?: unknown; url?: unknown; checksStatus?: unknown } | null;
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
    phase: str(body.phase),
    prNumber: num(pr.number),
    prUrl: str(pr.url),
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
    criteria?: { index?: unknown; verdict?: unknown }[];
  };
  const criteria = Array.isArray(raw?.criteria) ? raw.criteria : [];
  const unmet = criteria.flatMap((one, at) =>
    one?.verdict === 'met' ? [] : [(num(one?.index) ?? at) + 1],
  );
  return {
    at: last.entry.mtimeMs,
    firstAt: Math.min(...rounds.map((one) => one.entry.mtimeMs)),
    round: last.round,
    met: criteria.filter((one) => one?.verdict === 'met').length,
    total: criteria.length,
    unmet,
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

/** The learned median of a stage the mod times itself, once it has 3+ samples. */
function stageUsualMs(
  samples: Partial<Record<StageName, number[]>>,
  stage: StageName,
): number | null {
  const list = LEARNED_STAGES.has(stage) ? (samples[stage] ?? []) : [];
  return list.length >= MIN_SAMPLES ? median(list) * 1000 : null;
}

function stageRows(
  ev: Evidence,
  current: StageName,
  samples: Partial<Record<StageName, number[]>>,
): StageRow[] {
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
      usualMs: stageUsualMs(samples, name),
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

/** The stage name, or the stage and what it is doing: `check · round 2 · 5/6 met`. */
function stepOf(
  stage: StageName,
  ev: Evidence,
  progress: Progress | null,
  prNumber: number | null,
): string {
  const parts: (string | null)[] = [stage];
  switch (stage) {
    case 'build':
      if (ev.build) parts.push(plural(ev.build.count, 'commit'));
      break;
    case 'check':
      if (ev.check)
        parts.push(
          `round ${ev.check.round}`,
          `${ev.check.met}/${ev.check.total} met`,
        );
      break;
    case 'handoff':
      parts.push(progress?.phase ?? ev.handoff?.step ?? null);
      break;
    case 'close': {
      const phase = progress?.phase ?? 'close-validation';
      const gate = ev.close?.gate;
      parts.push(phase === 'close-validation' && gate ? `gate ${gate}` : phase);
      break;
    }
    case 'merge':
      parts.push(
        prNumber === null ? 'PR' : `PR #${prNumber}`,
        progress?.phase ??
          (ev.envelope?.status === 'pending' ? 'waiting on merge' : null),
      );
      break;
  }
  return parts.filter(Boolean).join(' · ');
}

/** The stall verdict: learned medians first, else the 10-minute gate-log rule. */
function stallOf(
  stage: StageName,
  ev: Evidence,
  elapsedMs: number | null,
  usualMs: number | null,
  now: number,
): boolean {
  if (usualMs !== null && elapsedMs !== null)
    return elapsedMs > Math.max(2 * usualMs, MIN_STALL_MS);
  const idleMs = stage === 'close' && ev.close ? now - ev.close.at : 0;
  return idleMs > STALL_MS;
}

function attentionOf(
  status: string,
  checksStatus: string | null,
  isStalled: boolean,
): Attention {
  if (status === 'landed') return 'landed';
  if (status === 'blocked') return 'needs-you';
  if (FAILED.has(status)) return 'failed';
  if (checksStatus === 'failure') return 'failed';
  return isStalled ? 'slow' : 'working';
}

function deriveFocus(
  storyId: number,
  ev: Evidence,
  learned: Learned,
  samples: Partial<Record<StageName, number[]>>,
  ctx: Ctx,
): Focus {
  const isInFlight = ev.envelope === null;
  const { stage, progress } = pickStage(ev);
  const phase = phaseOf(stage, progress);
  const learnedPhase = phase ? learned.phases[phase] : undefined;
  const usualMs = phase
    ? learnedPhase && learnedPhase.samples >= MIN_SAMPLES
      ? learnedPhase.medianSeconds * 1000
      : null
    : stageUsualMs(samples, stage);
  const phaseStart = progress?.phaseStartedAt ?? stageStarts(ev)[stage];
  const phaseElapsedMs =
    isInFlight && phaseStart !== null
      ? Math.max(0, ctx.now - phaseStart)
      : null;
  const isStalled =
    isInFlight && stallOf(stage, ev, phaseElapsedMs, usualMs, ctx.now);
  const prNumber = ev.progress?.prNumber ?? ev.envelope?.prNumber ?? null;
  const status = ev.envelope?.status ?? 'in-flight';
  const checksStatus = ev.envelope?.checksStatus ?? null;
  const inClose = stage === 'close' && ev.close !== null;
  return {
    storyId,
    title: ev.init?.title ?? null,
    status,
    attention: attentionOf(status, checksStatus, isStalled),
    stage,
    step: stepOf(stage, ev, progress, prNumber),
    subject: ev.build?.subject ?? null,
    stages: stageRows(ev, stage, samples),
    closePhases: CLOSE_PHASES.map(
      (name): PhaseRow => ({
        name,
        seconds: ev.envelope?.phaseDurations[name] ?? null,
        usualSeconds: learned.phases[name]?.medianSeconds ?? null,
      }),
    ),
    prNumber,
    prUrl:
      ev.envelope?.prUrl ??
      (prNumber !== null && ctx.repoUrl
        ? `${ctx.repoUrl}/pull/${prNumber}`
        : null),
    checksStatus,
    elapsedSeconds: ev.envelope?.elapsedSeconds ?? null,
    phaseElapsedMs,
    usualMs,
    phase,
    quietMinutes:
      inClose && ev.close
        ? Math.floor(Math.max(0, ctx.now - ev.close.at) / 60_000)
        : null,
    lastGate: inClose ? (ev.close?.gate ?? null) : null,
    unmet: ev.check?.unmet ?? [],
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

function chipOf(
  id: number,
  envelope: Envelope | undefined,
  ledger: Ledger,
  focus: Focus | null,
): ChipState {
  const status = envelope?.status;
  if (status === 'landed') return 'landed';
  if (status === 'blocked') return 'needs-you';
  if (status && FAILED.has(status)) return 'failed';
  if (id === focus?.storyId) return 'focus';
  return ledger.dispatched.includes(id) ? 'in-flight' : 'queued';
}

/**
 * The newest live run ledger: chips while it runs; a roll-up once every Story
 * has a result, kept while one did not land, else for 10 minutes.
 */
async function readRun(
  $: EngineInterface,
  ctx: Ctx,
  envelopes: Stamped[],
  focus: Focus | null,
): Promise<RunLine | null> {
  for (const ledger of await readLedgers($, ctx)) {
    const results = new Map<number, Envelope>();
    for (const stamp of envelopes.filter((one) =>
      ledger.stories.includes(one.storyId),
    )) {
      const envelope = await readEnvelope($, ctx, stamp);
      if (envelope) results.set(stamp.storyId, envelope);
    }
    const chips = ledger.stories.map((storyId) => ({
      storyId,
      state: chipOf(storyId, results.get(storyId), ledger, focus),
    }));
    const isDone = ledger.stories.every((id) =>
      TERMINAL.has(results.get(id)?.status ?? ''),
    );
    const stragglerId = ledger.stories.find(
      (id) => results.get(id)?.status !== 'landed',
    );
    const ended = [...results.values()];
    const lastAt = Math.max(0, ...ended.map((one) => one.at));
    if (isDone && stragglerId === undefined && ctx.now - lastAt > LANDED_MS)
      continue;
    const straggled =
      isDone && stragglerId !== undefined ? results.get(stragglerId) : null;
    return {
      landed: chips.filter((chip) => chip.state === 'landed').length,
      total: ledger.stories.length,
      chips,
      isDone,
      spanMs: isDone
        ? lastAt -
          Math.min(
            ...ended.map((one) => one.at - (one.elapsedSeconds ?? 0) * 1000),
          )
        : null,
      straggler:
        straggled && stragglerId !== undefined
          ? {
              storyId: stragglerId,
              attention:
                straggled.status === 'blocked' ? 'needs-you' : 'failed',
              phase: straggled.phase,
            }
          : null,
    };
  }
  return null;
}

/** A landed result shows for 10 minutes; any other result for 2 hours. */
const isShown = (envelope: Envelope, now: number): boolean =>
  now - envelope.at <= (envelope.status === 'landed' ? LANDED_MS : RECENT_MS);

async function scan(
  $: EngineInterface,
): Promise<{ next: Snapshot; latest: Envelope | null }> {
  const root = await resolveRoot($);
  if (!(await $.fs.exists(join(root, '.agents')).catch(() => false)))
    return { next: EMPTY, latest: null };
  const { temp, repoUrl } = await resolveConfig($, root);
  const orchestration = `${temp}/orchestration`;
  const now = await $.clock.now();
  const [worktrees, files] = await Promise.all([
    listMatching($, join(root, '.worktrees'), WORKTREE),
    $.fs.list(orchestration).catch(() => []),
  ]);
  const ctx: Ctx = { root, temp, orchestration, files, now, repoUrl };
  const envelopes = stampFiles(files, ENVELOPE);
  const learned = await learn($, ctx, envelopes);
  const recent = newest(
    envelopes.filter((one) => now - one.mtimeMs <= RECENT_MS),
  );
  const latest = recent ? await readEnvelope($, ctx, recent) : null;
  const inFlight = pickInFlight(worktrees, envelopes);
  const shown = latest && isShown(latest, now) ? latest : null;
  const focusId = inFlight?.storyId ?? shown?.storyId;
  const focus =
    focusId === undefined
      ? null
      : deriveFocus(
          focusId,
          await gather($, ctx, focusId, inFlight ? null : shown),
          learned,
          await read($, stageSamples),
          ctx,
        );
  await track($, focus);
  const run = await readRun($, ctx, envelopes, focus);
  return { next: { focus, run, scannedAt: now }, latest };
}

/**
 * When the followed Story moves past a stage the mod times itself, keep how
 * long that stage took; the medians of these give build, check and handoff
 * their usual time.
 */
async function track($: EngineInterface, focus: Focus | null): Promise<void> {
  if (focus?.status !== 'in-flight') return;
  const held = await read($, tracked);
  const was = held?.storyId === focus.storyId ? held.stage : null;
  if (was === focus.stage) return;
  await update($, tracked, () => ({
    storyId: focus.storyId,
    stage: focus.stage,
  }));
  if (was === null || STAGES.indexOf(was) > STAGES.indexOf(focus.stage)) return;
  const row = focus.stages.find((one) => one.name === was);
  if (!row || !LEARNED_STAGES.has(was)) return;
  if (row.startedAt === null || row.endedAt === null) return;
  const seconds = (row.endedAt - row.startedAt) / 1000;
  if (seconds < 0) return;
  await update($, stageSamples, (held) => ({
    ...held,
    [was]: [...(held[was] ?? []), seconds].slice(-MAX_SAMPLES),
  }));
}

/** The toast for a Story turning slow, once per Story. */
function slowToast(focus: Focus): string {
  const where = focus.phase ?? focus.stage;
  const took =
    focus.phaseElapsedMs === null ? '' : ` ${clock(focus.phaseElapsedMs)}`;
  const usual =
    focus.usualMs === null ? '' : ` of usual ~${clock(focus.usualMs)}`;
  return `Story #${focus.storyId} is slow: ${where}${took}${usual}`;
}

/** Toasts each result and each first slow verdict once; the first scan only records. */
async function announce(
  $: EngineInterface,
  latest: Envelope | null,
  focus: Focus | null,
): Promise<void> {
  const seeded = await read($, isSeeded);
  if (!seeded) await update($, isSeeded, () => true);
  const pending: { key: string; text: string }[] = [];
  if (latest && TERMINAL.has(latest.status)) {
    const pr = latest.prNumber ? ` (PR #${latest.prNumber})` : '';
    pending.push({
      key: `${latest.storyId}:${latest.at}`,
      text: `Story #${latest.storyId} ${latest.status}${pr}`,
    });
  }
  if (focus?.attention === 'slow')
    pending.push({ key: `${focus.storyId}:slow`, text: slowToast(focus) });
  for (const one of pending) {
    if ((await read($, seen)).includes(one.key)) continue;
    await update($, seen, (list) => [...list, one.key].slice(-50));
    if (seeded) $.ui.toast(one.text);
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const { next, latest } = await scan($);
    await update($, snapshot, () => next);
    await announce($, latest, next.focus);
  } catch {
    // Read-only and best effort: a failed scan leaves the last drawing up.
  }
}

// --------------------------------------------------------------- drawing

const GLYPH: Record<Attention, string> = {
  working: '●',
  slow: '▲',
  'needs-you': '◆',
  failed: '✗',
  landed: '✓',
};
const COLOR: Record<Attention, string | null> = {
  working: null,
  slow: 'yellow',
  'needs-you': 'magenta',
  failed: 'red',
  landed: 'green',
};
const LABEL: Record<Attention, string> = {
  working: 'in flight',
  slow: 'slow',
  'needs-you': 'needs you',
  failed: 'failed',
  landed: 'landed',
};
const CHIP: Record<ChipState, string> = {
  landed: '✓',
  'needs-you': '◆',
  failed: '✗',
  focus: '●',
  'in-flight': '◐',
  queued: '○',
};

/** `0:45`, `5:39`, `1:05:00`. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Cut short with an ellipsis, never wrapped. */
function cut(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? '…' : `${text.slice(0, width - 1)}…`;
}

/** Six cells: one filled per finished or current stage. */
const meter = (stage: StageName): string =>
  STAGES.map((_, index) => (index <= STAGES.indexOf(stage) ? '▰' : '▱')).join(
    '',
  );

const ratioOf = (focus: Focus): string | null =>
  focus.usualMs && focus.phaseElapsedMs !== null
    ? `${(focus.phaseElapsedMs / focus.usualMs).toFixed(1)}×`
    : null;

/** A result that stopped the Story, as opposed to red checks on a live PR. */
const isStopped = (focus: Focus): boolean =>
  focus.status === 'blocked' || FAILED.has(focus.status);

const isChecksRed = (focus: Focus): boolean =>
  focus.attention === 'failed' && !isStopped(focus);

function timeOf(focus: Focus): string {
  if (focus.phaseElapsedMs === null)
    return focus.status === 'in-flight' ? '' : focus.status;
  const usual = focus.usualMs === null ? '' : ` / ~${clock(focus.usualMs)}`;
  return `${clock(focus.phaseElapsedMs)}${usual}`;
}

/** Line 1 after the Story: the outcome, the stopping point, or progress and time. */
function progressOf(focus: Focus): string {
  if (focus.attention === 'landed') {
    return [
      `landed in ${focus.elapsedSeconds === null ? '?' : clock(focus.elapsedSeconds * 1000)}`,
      focus.prNumber === null ? null : `PR #${focus.prNumber}`,
      focus.followUps === null ? null : plural(focus.followUps, 'follow-up'),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (isStopped(focus))
    return `${LABEL[focus.attention]} at ${focus.stage} · ${focus.problem ?? 'see the Story'}`;
  const step = isChecksRed(focus)
    ? `merge · PR #${focus.prNumber ?? '?'} · checks failing`
    : focus.step;
  return [`${meter(focus.stage)} ${step}`, timeOf(focus)]
    .filter(Boolean)
    .join('   ');
}

const chipsOf = (run: RunLine): string =>
  `run ${run.landed}/${run.total}  ${run.chips
    .map((chip) => `${CHIP[chip.state]}${chip.storyId}`)
    .join(' ')}`;

function headline(
  focus: Focus,
  run: RunLine | null,
  isNarrow: boolean,
): string {
  const title =
    !isNarrow && focus.title ? ` ${cut(focus.title, TITLE_CELLS)}` : '';
  return [
    `${GLYPH[focus.attention]} #${focus.storyId}${title}`,
    progressOf(focus),
    !isNarrow && run && !run.isDone ? chipsOf(run) : null,
  ]
    .filter(Boolean)
    .join('   ');
}

const unmetOf = (unmet: number[]): string => {
  const named = unmet.slice(0, MAX_UNMET).map((id) => `AC-${id}`);
  const more = unmet.length - named.length;
  return [...named, ...(more > 0 ? [`+${more}`] : [])].join(', ');
};

/** Line 2: only when the Story needs a look, and never repeating line 1. */
function attentionLine(focus: Focus): string | null {
  if (focus.attention === 'slow') {
    const parts = [
      ratioOf(focus) && `${ratioOf(focus)} usual`,
      focus.quietMinutes ? `gate log quiet ${focus.quietMinutes}m` : null,
      focus.lastGate ? `last gate ${focus.lastGate}` : null,
    ].filter(Boolean);
    return `↳ ${parts.length ? parts.join(' · ') : `${focus.stage} is past its usual time`}`;
  }
  if (isChecksRed(focus))
    return `↳ PR #${focus.prNumber ?? '?'} checks failing`;
  if (!isStopped(focus)) return null;
  const unmet =
    focus.stage === 'check' && focus.unmet.length
      ? `   ${unmetOf(focus.unmet)}`
      : '';
  return `↳ ${focus.nextCommand ?? `see Story #${focus.storyId}`}${unmet}`;
}

function rollupOf(run: RunLine): string {
  const straggler = run.straggler;
  const glyph = GLYPH[straggler?.attention ?? 'landed'];
  const span = run.spanMs === null ? '' : ` in ${clock(run.spanMs)}`;
  const stopped = straggler
    ? ` · #${straggler.storyId} ${LABEL[straggler.attention]}${straggler.phase ? ` at ${straggler.phase}` : ''}`
    : '';
  return `${glyph} run ${run.landed}/${run.total} landed${span}${stopped}   ${chipsOf(
    run,
  )
    .split('  ')
    .slice(1)
    .join('  ')}`;
}

type Line = { text: string; color: string | null };

type Band = {
  /** `#<id>` or `run`, joined with the attention to key Hide. */
  key: string;
  attention: Attention;
  lines: Line[];
  /** The command line 2's Copy button copies. */
  copy: string | null;
  /** Where line 2's Open PR link goes. */
  prUrl: string | null;
};

/** The band for a body this wide; null draws nothing. */
function compose({ focus, run }: Snapshot, columns: number): Band | null {
  const isNarrow = columns < NARROW;
  const first = Math.max(20, columns - BUTTON_CELLS);
  if (run?.isDone && focus?.status !== 'in-flight') {
    const attention = run.straggler?.attention ?? 'landed';
    return {
      key: 'run',
      attention,
      lines: [{ text: cut(rollupOf(run), first), color: COLOR[attention] }],
      copy: null,
      prUrl: null,
    };
  }
  if (!focus) return null;
  const color = COLOR[focus.attention];
  const lines: Line[] = [
    { text: cut(headline(focus, run, isNarrow), first), color },
  ];
  const second = attentionLine(focus);
  const copy = isStopped(focus) ? focus.nextCommand : null;
  const prUrl = isChecksRed(focus) ? focus.prUrl : null;
  if (second) {
    const room = columns - (copy || prUrl ? ACTION_CELLS : 0);
    lines.push({ text: cut(second, Math.max(20, room)), color });
  }
  return {
    key: `#${focus.storyId}`,
    attention: focus.attention,
    lines,
    copy,
    prUrl,
  };
}

const clockOf = (ms: number | null): string => {
  if (ms === null) return '—';
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
};

/** A bar on one shared scale, with `▏` where the usual time falls. */
function bar(tookMs: number | null, usualMs: number | null, unit: number) {
  if (tookMs === null || unit <= 0) return '';
  const cells = [...'█'.repeat(Math.round(tookMs / unit))];
  if (usualMs !== null) {
    const mark = Math.round(usualMs / unit);
    while (cells.length <= mark) cells.push(' ');
    cells[mark] = '▏';
  }
  return cells.join('').trimEnd();
}

function stageDetail(focus: Focus, name: StageName): string {
  if (name === 'build') return focus.subject ?? '';
  return name === focus.stage
    ? focus.step.split(' · ').slice(1).join(' · ')
    : '';
}

function attentionRows(focus: Focus): string[] {
  if (focus.attention === 'slow') {
    const took =
      focus.phaseElapsedMs === null ? '—' : clock(focus.phaseElapsedMs);
    const usual =
      focus.usualMs === null ? '' : `   usual ~${clock(focus.usualMs)}`;
    const ratio = ratioOf(focus) ? `   ${ratioOf(focus)}` : '';
    const quiet = focus.quietMinutes
      ? `   gate log quiet ${focus.quietMinutes}m`
      : '';
    return [
      `  ▲ ${focus.phase ?? focus.stage}   ${took}${usual}${ratio}${quiet}`,
    ];
  }
  if (isChecksRed(focus))
    return [`  ✗ PR #${focus.prNumber ?? '?'} checks failing`];
  if (!isStopped(focus)) return [];
  return [
    `  ${GLYPH[focus.attention]} ${focus.problem ?? LABEL[focus.attention]} at ${focus.stage}`,
    ...(focus.unmet.length ? [`  unmet ${unmetOf(focus.unmet)}`] : []),
    `  next: ${focus.nextCommand ?? `see Story #${focus.storyId}`}`,
  ];
}

/** The Details pane: what needs a look, then the timeline against usual, then the run. */
function details({ focus, run }: Snapshot, now: number): string[] {
  if (!focus) return ['No /mandrel-deliver Story in flight or recent.'];
  const at = STAGES.indexOf(focus.stage);
  const rows = focus.stages.map((row, index) => {
    const end =
      row.endedAt ??
      (index === at && focus.status === 'in-flight' ? now : null);
    return {
      row,
      index,
      tookMs:
        row.startedAt !== null && end !== null ? end - row.startedAt : null,
    };
  });
  const phases = focus.closePhases.map((phase) => ({
    phase,
    tookMs: phase.seconds === null ? null : phase.seconds * 1000,
    usualMs: phase.usualSeconds === null ? null : phase.usualSeconds * 1000,
  }));
  const longest = Math.max(
    0,
    ...rows.flatMap((one) => [one.tookMs ?? 0, one.row.usualMs ?? 0]),
    ...phases.flatMap((one) => [one.tookMs ?? 0, one.usualMs ?? 0]),
  );
  const unit = longest / BAR_CELLS;
  const total =
    focus.elapsedSeconds !== null
      ? focus.elapsedSeconds * 1000
      : now -
        (focus.stages.find((row) => row.startedAt !== null)?.startedAt ?? now);
  const timeline = rows.flatMap(({ row, index, tookMs }) => {
    const mark =
      index < at || focus.attention === 'landed'
        ? '✓'
        : index === at
          ? GLYPH[focus.attention]
          : '○';
    const took = tookMs === null ? '' : clock(tookMs);
    const line = `  ${mark} ${row.name.padEnd(17)} ${clockOf(row.startedAt).padEnd(9)} ${took.padStart(7)}   ${bar(tookMs, row.usualMs, unit)}`;
    const detail = stageDetail(focus, row.name);
    const head = `${line}${detail ? `   ${detail}` : ''}`.trimEnd();
    if (row.name !== 'close' || index > at) return [head];
    return [
      head,
      ...phases.map(({ phase, tookMs: phaseMs, usualMs }) =>
        `      ${phase.name.padEnd(17)} ${''.padEnd(5)} ${(phaseMs === null ? '—' : clock(phaseMs)).padStart(7)}   ${bar(phaseMs, usualMs, unit)}${usualMs === null ? '' : `   ~${clock(usualMs)}`}`.trimEnd(),
      ),
    ];
  });
  const attention = attentionRows(focus);
  return [
    `#${focus.storyId}${focus.title ? ` ${focus.title}` : ''}   ${LABEL[focus.attention]} · ${clock(total)}`,
    ...(attention.length ? ['NEEDS ATTENTION', ...attention] : []),
    'TIMELINE',
    ...timeline,
    ...(run
      ? [
          `RUN ${run.landed}/${run.total}   ${run.chips.map((chip) => `${CHIP[chip.state]} #${chip.storyId}`).join('   ')}`,
        ]
      : []),
    '▏ marks the usual time; every bar shares one scale',
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
    const drawn = compose(current, e.props.bodyColumns);
    if (!drawn) return next(e);
    const hideKey = `${drawn.key}:${drawn.attention}`;
    if ((await read($, hiddenFor)) === hideKey) return next(e);
    const { Box, Button, Link, Text } = $.ui.resolve(e);
    const [first, ...rest] = drawn.lines;
    if (!first) return next(e);
    const style = (line: Line) =>
      line.color ? { color: line.color } : { dimColor: true };
    const copy = drawn.copy;
    return (
      <Box flexDirection="column">
        <Box>
          <Text {...style(first)} wrap="truncate">
            {first.text}
          </Text>
          <Button
            key="hide"
            label="Hide"
            onPress={() => update($, hiddenFor, () => hideKey)}
          />
          <Button
            key="details"
            label="Details"
            onPress={() => $.ui.open({ id: PANE, title: 'mandrel-status' })}
          />
        </Box>
        {rest.map((line, index) => (
          <Box key={`line-${index}`}>
            <Text {...style(line)} wrap="truncate">
              {line.text}
            </Text>
            {copy ? (
              <Button
                key="copy"
                label="Copy"
                onPress={(press) => {
                  void $.ui.copy({ text: copy, surface: press.surface });
                }}
              />
            ) : null}
            {drawn.prUrl ? (
              <Link key="pr" href={drawn.prUrl} label="Open PR" />
            ) : null}
          </Box>
        ))}
      </Box>
    );
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const current = await read($, snapshot);
    return (
      <Box flexDirection="column">
        {details(current, current.scannedAt).map((line, index) => (
          <Text key={`row-${index}`} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    );
  });
};
