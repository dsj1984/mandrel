/** A Story whose worktree exists and whose close has not finished. */
export type InFlight = {
  storyId: number;
  /** True once close has written its gate log. */
  isClosing: boolean;
  /** Minutes since the gate log last changed, when over the stall limit. */
  stalledMinutes: number | null;
};

/** The newest terminal envelope from the last two hours. */
export type LastResult = {
  storyId: number;
  status: string;
  prNumber: number | null;
  checksStatus: string | null;
  elapsedSeconds: number | null;
};

export type Snapshot = {
  inFlight: InFlight | null;
  last: LastResult | null;
};

declare module 'claude-code' {
  interface PluginState {
    'mandrel-status': {
      snapshot: Snapshot;
      /** `<storyId>:<mtimeMs>` of every envelope already seen. */
      seen: string[];
      /** False until the first scan, which records envelopes without a toast. */
      isSeeded: boolean;
    };
  }
}
