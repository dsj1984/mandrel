/**
 * Forked entry for the whole-tree duplication scan. Disconnecting after the
 * reply lets the process end by itself, so a coverage run still flushes.
 */

import { resolveDetectClones, scanDuplication } from './duplication-scanner.js';

process.once('message', async (params) => {
  let reply;
  try {
    const detect = resolveDetectClones();
    reply = { rows: await scanDuplication({ ...params, detect }) };
  } catch (err) {
    reply = {
      error: { message: err?.message ?? String(err), code: err?.code },
    };
  }
  process.send(reply, () => process.disconnect());
});
