/**
 * epic-merge-lock-stale — refuse-and-print warning check.
 *
 * Detects orphan `epic-<id>.merge.lock` files left behind by a crashed
 * or hung `withEpicMergeLock()` holder. The live serialization path is
 * owned by `lib/epic-merge-lock.js` itself; this check intentionally
 * does NOT serialize against it. Instead, at preflight time it probes
 * the lock file for each known epic and surfaces a warning when:
 *
 *   - the lock file exists, AND
 *   - the recorded holder PID is not alive (per `process.kill(pid, 0)`).
 *
 * Severity is `warning` rather than `blocker` because the live lock
 * implementation already steals stale locks on its own (per
 * `tryStealStale()` in epic-merge-lock.js). Surfacing the residue
 * earlier just helps operators diagnose hung CI runs before they
 * snowball into wave-aggregation timeouts. The fix is a literal
 * `rm <lockPath>` — refuse-and-print so the operator runs it
 * deliberately.
 *
 * Reads `state.fs.epicMergeLocks`, a map of `epicId → { exists, pid,
 * holderAlive, path, ... }` populated by state.js.
 */
export default {
  id: 'epic-merge-lock-stale',
  severity: 'warning',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const locks = state?.fs?.epicMergeLocks ?? {};
    for (const [epicId, info] of Object.entries(locks)) {
      if (!info?.exists) continue;
      if (info.holderAlive) continue;
      // Lock exists and the holder PID is not alive — orphan.
      return {
        id: 'epic-merge-lock-stale',
        severity: 'warning',
        scope: state?.scope ?? 'story-close',
        summary: `Orphan epic merge lock for epic/${epicId} (holder PID ${info.pid ?? 'unknown'} not alive)`,
        detail: [
          `lock path: ${info.path}`,
          `holder pid: ${info.pid ?? 'unknown'}`,
          info.acquiredAt
            ? `acquired at: ${new Date(info.acquiredAt).toISOString()}`
            : 'acquired at: unknown',
          'The live lock will steal this on next contention, but the residue can be cleared manually.',
        ].join('\n'),
        fixCommand: `rm "${info.path}"`,
        autoCorrectable: false,
      };
    }
    return null;
  },
};
