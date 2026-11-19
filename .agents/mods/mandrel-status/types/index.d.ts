/**
 * What a person does about a stopped Story, worded for the band. `pr` blocks
 * are cleared on GitHub and get an `Open PR` link; `copy` results (`failed`,
 * `escalated`) get a `Copy` button for the envelope's `nextCommand`.
 */
export type Fix = {
  /** What happened, in a few plain words: `needs your approval`. */
  label: string;
  /** What to do next: `review and approve the PR`. */
  action: string;
  button: 'pr' | 'copy';
};

/** A Story stopped on a person, read from its terminal envelope. */
export type Blocker = {
  storyId: number;
  /** The envelope file's mtime, epoch milliseconds. */
  at: number;
  /** From `story-init-result-<id>.log`, when it is still on disk. */
  title: string | null;
  fix: Fix;
  prNumber: number | null;
  /** The envelope's `pr.url`, else built from `github.owner` / `github.repo`. */
  prUrl: string | null;
  /** The envelope's `nextCommand`. */
  command: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'mandrel-status': {
      /** Every Story stopped on a person, newest first. */
      blockers: Blocker[];
      /** `<storyId>:<envelope mtime>` the person hid; a newer result shows again. */
      hiddenFor: string | null;
    };
  }
}
