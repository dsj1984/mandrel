/** The six stages of a /mandrel-deliver Story, in order. */
export type StageName =
  | 'start'
  | 'build'
  | 'check'
  | 'handoff'
  | 'close'
  | 'merge';

/**
 * What the band says about a Story; it picks the glyph, the color and whether
 * a second line shows. `needs-you` is a `blocked` result (the HITL pause);
 * `failed` is a `failed` / `escalated` result or a PR whose checks are red.
 */
export type Attention = 'working' | 'slow' | 'needs-you' | 'failed' | 'landed';

/** One stage as the Details pane lists it; times in epoch milliseconds. */
export type StageRow = {
  name: StageName;
  startedAt: number | null;
  /** The next stage's start, or null while this one is current or pending. */
  endedAt: number | null;
  /** The learned median of the stage, once it has 3+ samples. */
  usualMs: number | null;
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
  attention: Attention;
  stage: StageName;
  /** The current stage's step, already worded: `check · round 2 · 5/6 met`. */
  step: string;
  /** The last commit subject, shown only in the Details pane. */
  subject: string | null;
  stages: StageRow[];
  closePhases: PhaseRow[];
  prNumber: number | null;
  /** The PR's web address: the envelope's `pr.url`, else built from `github`. */
  prUrl: string | null;
  checksStatus: string | null;
  /** The envelope's `elapsedSeconds`, for a finished result. */
  elapsedSeconds: number | null;
  /** Milliseconds into the current phase, while in flight. */
  phaseElapsedMs: number | null;
  /** The learned median of the current phase or stage, once it has 3+ samples. */
  usualMs: number | null;
  /** The close phase being timed, when the stage has one. */
  phase: string | null;
  /** Minutes the close-gates log has been quiet, while in close. */
  quietMinutes: number | null;
  /** The gate named by the close-gates log's last line, while in close. */
  lastGate: string | null;
  /** 1-based ids of the newest verdict round's criteria not `met`. */
  unmet: number[];
  /** `blocked.blockClass` or `failure.reason`. */
  problem: string | null;
  nextCommand: string | null;
  /** Bullets in `follow-ups-rollup-<id>.md`, when it exists. */
  followUps: number | null;
};

/** How one ledger Story reads as a run chip. */
export type ChipState =
  | 'landed'
  | 'needs-you'
  | 'failed'
  | 'focus'
  | 'in-flight'
  | 'undispatched';

/** A Story that ended without landing, named by the run roll-up. */
export type Straggler = {
  storyId: number;
  attention: 'needs-you' | 'failed';
  /** The envelope's `phase`: where it stopped. */
  phase: string | null;
};

/** The newest live multi-Story run ledger. */
export type RunLine = {
  landed: number;
  total: number;
  chips: { storyId: number; state: ChipState }[];
  /** True once every ledger Story has a terminal envelope. */
  isDone: boolean;
  /** From the earliest start to the newest result, once done. */
  spanMs: number | null;
  straggler: Straggler | null;
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

/** The followed Story and stage of the last scan, to see a stage finish. */
export type Tracked = { storyId: number; stage: StageName };

declare module 'claude-code' {
  interface PluginState {
    'mandrel-status': {
      snapshot: Snapshot;
      /** Envelope keys and `<storyId>:slow` of everything already toasted or recorded. */
      seen: string[];
      /** False until the first scan, which records without a toast. */
      isSeeded: boolean;
      learned: Learned;
      /** Durations in seconds of finished stages this mod watched, newest 30 each. */
      stageSamples: Partial<Record<StageName, number[]>>;
      tracked: Tracked | null;
      /** `<band key>:<attention>` the person hid; any change shows the band again. */
      hiddenFor: string | null;
    };
  }
}
