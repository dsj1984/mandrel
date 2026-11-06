/**
 * suite-sizing.js — size a declared workload before it reserves: run its
 * `sizeCommand` (no shell, async, 60 s bound), read the slice's test-file
 * count from the last stdout line, and pick the first tier that covers it.
 * Every failure books the entry's full declared weight.
 */
import { spawn } from 'node:child_process';

const SIZE_TIMEOUT_MS = 60_000;

const LOCK_TAG = '[full-suite-lock]';

const COUNT_RE = /^\d+$/;

/**
 * @param {{ command: string, cwd?: string, env?: Record<string, string|undefined>,
 *   timeoutMs?: number, spawnFn?: typeof spawn }} opts
 * @returns {Promise<{ count: number }|{ reason: string }>}
 */
export function runSizeCommand({
  command,
  cwd,
  env,
  timeoutMs = SIZE_TIMEOUT_MS,
  spawnFn = spawn,
}) {
  const [cmd, ...args] = String(command ?? '')
    .split(/\s+/)
    .filter(Boolean);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      resolve({ reason: `spawn failed: ${err.message}` });
      return;
    }
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ reason: `spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(sizeVerdict({ code, stdout, timedOut, timeoutMs }));
    });
  });
}

function sizeVerdict({ code, stdout, timedOut, timeoutMs }) {
  if (timedOut) return { reason: `timed out after ${timeoutMs}ms` };
  if (code !== 0) return { reason: `exited ${code}` };
  const last = stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .at(-1)
    ?.trim();
  return COUNT_RE.test(last ?? '')
    ? { count: Number(last) }
    : { reason: 'printed no file count' };
}

/**
 * The first tier (ascending `maxFiles`) covering `count`; full weight when
 * none does, when sizing failed, or when the tier outweighs the entry.
 *
 * @param {{ weight: number, tiers: Array<{ maxFiles: number, weight: number }> }} workload
 * @param {{ count?: number, reason?: string }} sized
 * @returns {{ weight: number, reason: string|null }}
 */
function selectTierWeight({ weight, tiers }, sized) {
  if (sized.count === undefined) return { weight, reason: sized.reason };
  const tier = [...tiers]
    .sort((a, b) => a.maxFiles - b.maxFiles)
    .find((t) => sized.count <= t.maxFiles);
  if (!tier) return { weight, reason: 'no tier covers the slice' };
  if (tier.weight > weight) {
    return {
      weight,
      reason: `tier weight ${tier.weight} exceeds the declared weight`,
    };
  }
  return { weight: tier.weight, reason: null };
}

/**
 * A declared workload with tiers, re-weighted to its slice; any other
 * workload unchanged.
 *
 * @param {object} workload
 * @param {{ cwd?: string, env?: object, log: (m: string) => void,
 *   runSizeFn?: typeof runSizeCommand }} opts
 * @returns {Promise<object>}
 */
export async function sizeWorkload(
  workload,
  { cwd, env, log, runSizeFn = runSizeCommand },
) {
  if (workload?.kind !== 'declared' || !workload.tiers) return workload;
  const sized = await runSizeFn({ command: workload.sizeCommand, cwd, env });
  const pick = selectTierWeight(workload, sized);
  const slice = sized.count === undefined ? 'unsized' : `${sized.count} files`;
  const why = pick.reason ? `, full weight: ${pick.reason}` : '';
  log(
    `${LOCK_TAG} ⚖ sized \`${workload.command}\` with \`${workload.sizeCommand}\`: ${slice}${why} → weight ${pick.weight} of ${workload.weight}.`,
  );
  return {
    ...workload,
    weight: pick.weight,
    declaredWeight: workload.weight,
    sliceFiles: sized.count ?? null,
  };
}
/** The declared-run admitted line; `null` leaves the exclusive wording. */
export function admittedLine(workload, waited, passed = 0) {
  const record = admissionRecord(workload, passed > 0);
  if (!record) return null;
  const slice =
    record.sliceFiles === null ? 'unsized' : `slice ${record.sliceFiles} files`;
  const backfill =
    passed > 0 ? `, backfilled past ${passed} earlier waiter(s)` : '';
  return `${LOCK_TAG} ✅ admitted \`${workload.command}\` (weight ${record.weight} of declared ${record.declaredWeight}, ${slice}, waited ${waited}s${backfill}).`;
}

/**
 * What a declared run was admitted at; `null` for any other workload.
 *
 * @returns {{ weight: number, declaredWeight: number,
 *   sliceFiles: number|null, backfilled: boolean }|null}
 */
export function admissionRecord(workload, backfilled) {
  if (workload?.kind !== 'declared') return null;
  return {
    weight: workload.weight,
    declaredWeight: workload.declaredWeight ?? workload.weight,
    sliceFiles: workload.sliceFiles ?? null,
    backfilled: Boolean(backfilled),
  };
}

/** The sizing and backfill fields a workload entry declares, if any. */
export function sizingFields(entry) {
  return {
    ...(entry.tiers
      ? { tiers: entry.tiers, sizeCommand: entry.sizeCommand }
      : {}),
    ...(entry.backfill === true ? { backfill: true } : {}),
  };
}
