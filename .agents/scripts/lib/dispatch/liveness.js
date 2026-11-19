/**
 * Whether a recorded delivery process still runs, probed with signal 0,
 * which delivers nothing. A cloud or unrecorded Story is `unknown`.
 */
export function processState(
  record,
  { kill = process.kill.bind(process) } = {},
) {
  const startedAt = record?.startedAt ?? null;
  if (!record || record.sessionUrl || !Number.isInteger(record.pid)) {
    return { state: 'unknown', startedAt };
  }
  try {
    kill(record.pid, 0);
    return { state: 'working', startedAt };
  } catch (err) {
    if (err?.code === 'EPERM') return { state: 'working', startedAt };
    if (err?.code === 'ESRCH') return { state: 'exited', startedAt };
    return { state: 'unknown', startedAt };
  }
}
