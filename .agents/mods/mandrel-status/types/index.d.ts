/** The six stages of a /mandrel-deliver Story, in order. */
export type StageName =
  | 'start'
  | 'build'
  | 'check'
  | 'handoff'
  | 'close'
  | 'merge';

/** One stage as the Details pane lists it; times in epoch milliseconds. */
export type StageRow = {
  name: StageName;
  startedAt: number | null;
  /** The next stage's start, or null while this one is current or pending. */
  endedAt: number | null;
};

/** One close phase: its recorded duration and the learned median, in seconds. */
export type PhaseRow = {
  name: string;
  seconds: number | null;
  usualSeconds: number | null;
};

/** The Story the band follows: in flight, or the newest recent result. */
export type Focus = {
  storyId: number;
  title: string | null;
  /** `in-flight`, or the terminal envelope's `status`. */
  status: string;
  stage: StageName;
  /** The current stage's step detail, already worded. */
  detail: string;
  stages: StageRow[];
  handoffSteps: { name: string; at: number }[];
  closePhases: PhaseRow[];
  prNumber: number | null;
  checksStatus: string | null;
  /** The envelope's `elapsedSeconds`, for a finished result. */
  elapsedSeconds: number | null;
  /** Milliseconds into the current phase, while in flight. */
  phaseElapsedMs: number | null;
  /** The learned median of the current phase, once it has 3+ samples. */
  usualMs: number | null;
  isStalled: boolean;
  /** Minutes the gate log has been quiet, when the 10-minute rule fired. */
  idleMinutes: number | null;
  /** `blocked.blockClass` or `failure.reason`. */
  problem: string | null;
  nextCommand: string | null;
  /** Bullets in `follow-ups-rollup-<id>.md`, when it exists. */
  followUps: number | null;
};

/** The newest live multi-Story run ledger. */
export type RunLine = {
  landed: number;
  total: number;
  current: { storyId: number; stage: string } | null;
  queued: number;
};

export type Snapshot = {
  focus: Focus | null;
  run: RunLine | null;
  /** When the scan ran, epoch milliseconds; 0 before the first. */
  scannedAt: number;
};

/** Per close phase: the median of the newest terminal envelopes' timings. */
export type Learned = {
  /** When the medians were last computed; 0 before the first pass. */
  at: number;
  phases: Record<string, { medianSeconds: number; samples: number }>;
};

declare module 'claude-code' {
  interface PluginState {
    'mandrel-status': {
      snapshot: Snapshot;
      /** `<storyId>:<mtimeMs>` of every envelope already seen. */
      seen: string[];
      /** False until the first scan, which records envelopes without a toast. */
      isSeeded: boolean;
      learned: Learned;
      /** The focus Story the person hid the band for; it shows again on a new one. */
      hiddenFor: number | null;
    };
  }
}
