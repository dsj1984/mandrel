// Runs the real lint driver over a probe roster: the blocking-write probe,
// plus a Node sibling that touches stdout while the probe writes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLintTasks } from '../../../scripts/run-lint.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { exitCode } = await runLintTasks({
  tasks: [
    {
      name: 'probe',
      cmd: process.execPath,
      args: [path.join(here, 'probe.js')],
    },
    {
      name: 'sibling',
      cmd: process.execPath,
      args: [
        '-e',
        "process.stdout.write('sibling\\n'); setTimeout(() => {}, 1500)",
      ],
    },
  ],
});
process.exitCode = exitCode;
