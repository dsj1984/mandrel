---
description: A valid interval loop unit with no verify (verify is optional for interval cadence).
loop:
  cadence: interval
  goal: Poll the deploy status every five minutes and report when green.
  maxRounds: 12
  onExhaust: block
---

# Valid interval loop unit (positive-case fixture)

Interval cadence is externally scheduled, so `verify` is optional. This
unit omits it and validates clean.
