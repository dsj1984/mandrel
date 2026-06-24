---
description: A self-paced loop unit that is missing its required verify command.
loop:
  cadence: self-paced
  goal: Keep the dashboard data fresh until the operator stops the loop.
  maxRounds: 10
  onExhaust: report
---

# Malformed loop unit (negative-case fixture)

This unit declares `cadence: self-paced` but omits `verify`, which the
loop-unit schema requires for the self-paced cadence. It exists to prove
that `validateLoopUnit` rejects the file and names the missing field.
