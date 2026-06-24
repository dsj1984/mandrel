---
description: A valid self-paced loop unit with a verify command.
loop:
  cadence: self-paced
  goal: Keep the changelog in sync with merged PRs until caught up.
  verify: npm run docs:check
  maxRounds: 5
  onExhaust: hand-back
---

# Valid self-paced loop unit (positive-case fixture)

Self-paced cadence carries a `verify` command, so each round has a
checkable definition of done. This unit validates clean.
