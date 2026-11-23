// Writes 1 MiB to fd 1 the way Biome does: a blocking write loop. On a
// non-blocking stdout with a full pipe the write throws EAGAIN, and the
// probe exits 101 like Biome's panic.
import fs from 'node:fs';

setTimeout(() => {
  let rest = Buffer.alloc(1 << 20, 97);
  try {
    while (rest.length > 0) rest = rest.subarray(fs.writeSync(1, rest));
  } catch (err) {
    fs.writeSync(2, `PROBE ${err.code}\n`);
    process.exitCode = 101;
  }
}, 300);
