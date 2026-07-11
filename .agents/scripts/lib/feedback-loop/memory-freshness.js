/**
 * memory-freshness.js — walker + verifier for the `/plan` Phase 0
 * memory-freshness pre-flight. Story #2557 / Epic #2547. Tech Spec #2550.
 *
 * Walks every `.md` file under a memory directory (typically
 * `~/.claude/projects/<repo>/memory/`), parses the YAML frontmatter, extracts
 * candidate references (file paths, GitHub labels, GitHub issue numbers),
 * verifies each, and rewrites the frontmatter with `stale: true`,
 * `staleReason: "..."`, `staleDetectedAt: "<iso>"` when a reference is
 * **confirmed** dead.
 *
 * Three-valued probes (Story #4414 / Epic #4406). Every reference resolves to
 * one of three states — `exists`, `missing`, or `unknown` — so only a
 * *confirmed-missing* (or confirmed-closed) reference marks an entry stale.
 * A transient `gh` failure (rate-limit, auth, network) resolves to `unknown`
 * and mutates nothing: it can neither newly-stale a fresh entry nor un-stale a
 * previously-stale one. This closes the poison-on-outage bug where any `gh`
 * exit 1 was read as "reference deleted".
 *
 * Reversible stale path (Story #4414). A previously-staled entry whose
 * references are **all** re-confirmed `exists` on a later scan is un-staled:
 * the `stale` / `staleReason` / `staleDetectedAt` keys are stripped via the
 * same atomic rewrite path used to stamp them. An entry that is still dead, or
 * whose recovery cannot be confirmed (any `unknown` probe), is left
 * byte-identical — so a stuck entry is never thrashed and recovery is only
 * ever asserted from positive evidence.
 *
 * The walker is idempotent: a still-stale entry and a still-fresh entry are
 * both left untouched, so a subsequent scan over an unchanged memory dir
 * produces byte-identical frontmatter.
 *
 * Best-effort guarantees:
 * - The memory directory missing yields `{ scanned: 0, staleEntries: [],
 *   unstaledEntries: [], errors: [{ phase: 'discover', reason: '...' }] }` and
 *   no throw.
 * - Per-file parse / probe failures are captured in `errors[]` and the file
 *   is skipped — the walker keeps going.
 * - The function NEVER throws.
 *
 * Test seams:
 * - `fsImpl` — node:fs/promises-compatible surface (`readdir`, `readFile`,
 *   `writeFile`, `rename`, `access`, `stat`).
 * - `gitImpl` — unused today; kept in the signature for symmetry with the
 *   Tech Spec contract and forward compatibility (e.g. branch-existence
 *   probes).
 * - `ghPath` — path to the `gh` binary used for label and issue probes. When
 *   `gh` is not on PATH, label/issue probes are skipped (best-effort).
 * - `spawnImpl` — node:child_process spawn-compatible seam for tests.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import * as defaultFs from 'node:fs/promises';
import * as path from 'node:path';

const FRONTMATTER_FENCE = '---';

/**
 * Default per-probe watchdog bound for the `gh` spawns. Matches
 * `graduator-core`'s `DEFAULT_RUN_CHILD_TIMEOUT_MS` (30000 ms) — the other
 * feedback-loop spawn site Epic #4406 bounded so a hung `gh` cannot block a
 * finalize/scan forever. Caller-overridable via `scanMemoryFreshness`'s
 * `probeTimeoutMs`.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 30000;

/**
 * Arm a caller-overridable watchdog over a probe's spawned child and return a
 * `settle(value)` function the probe's own event handlers call to resolve.
 * The first `settle` wins (subsequent calls are ignored) and always clears the
 * timer, so it never outlives its purpose.
 *
 * On timeout the child is SIGKILL'd and the probe settles to the supplied
 * `onTimeout` value — for these three-valued probes always `{ status:
 * 'unknown' }`, so a hung `gh` never confirms a `missing` reference.
 *
 * The timer is intentionally **not** `.unref()`'d. An unref'd watchdog cannot
 * keep an otherwise-idle event loop alive to fire, so on a stub child (or a
 * real child whose stdio handles close early) it would silently never fire and
 * the awaiting promise would hang forever — the exact defect Epic #4406 fixed
 * in `graduator-core.runChild`. `settle()` always `clearTimeout()`s it.
 *
 * @param {object} opts
 * @param {{ kill?: Function }} opts.child
 * @param {number} opts.timeoutMs — watchdog bound; `0`/`Infinity` disables it
 * @param {Function} opts.resolve — the enclosing Promise's resolve
 * @param {*} opts.onTimeout — value to settle with on overrun
 * @returns {(value: *) => void}
 */
function armProbeWatchdog({ child, timeoutMs, resolve, onTimeout }) {
  let settled = false;
  let timer = null;
  const settle = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(value);
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL');
      } catch {
        // Killing an already-dead / stub child is a no-op we ignore.
      }
      settle(onTimeout);
    }, timeoutMs);
  }
  return settle;
}

const FILE_PATH_REGEX =
  /(?<![\w/])((?:\.{1,2}\/|\/)?[\w.\-/]+\.[A-Za-z0-9]{1,8})\b/g;
const LABEL_REGEX = /\b([a-z][\w-]*::[a-z][\w-]+)\b/g;
const ISSUE_REGEX = /(?:^|[^&\w])#(\d+)\b/g;

/**
 * Parse YAML frontmatter from a markdown buffer.
 *
 * Returns `{ frontmatter: Record<string,string>, body: string, keyOrder:
 * string[], hasFrontmatter: boolean }`. The parser is intentionally narrow:
 * the memory substrate uses a flat string-valued frontmatter (no nesting,
 * no lists), so a minimal `key: value` reader avoids dragging in a YAML
 * dependency.
 *
 * Lines that do not match `^([A-Za-z0-9_-]+):\s*(.*)$` inside the
 * frontmatter block are preserved verbatim into the body to keep round-trip
 * safety — we never silently drop content.
 *
 * @param {string} raw
 * @returns {{ frontmatter: Record<string,string>, body: string, keyOrder: string[], hasFrontmatter: boolean }}
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { frontmatter: {}, body: '', keyOrder: [], hasFrontmatter: false };
  }

  // Tolerate a leading BOM or CR.
  const text = raw.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);

  if (lines[0] !== FRONTMATTER_FENCE) {
    return { frontmatter: {}, body: raw, keyOrder: [], hasFrontmatter: false };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // Unterminated frontmatter — treat the whole file as body to stay safe.
    return { frontmatter: {}, body: raw, keyOrder: [], hasFrontmatter: false };
  }

  const frontmatter = {};
  const keyOrder = [];
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    // Strip a single surrounding pair of quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(frontmatter, key)) {
      keyOrder.push(key);
    }
    frontmatter[key] = value;
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { frontmatter, body, keyOrder, hasFrontmatter: true };
}

/**
 * Re-render a parsed memory entry back to a markdown string. Preserves the
 * original key order and appends any newly-added keys (in stable order) at
 * the tail of the frontmatter block.
 *
 * @param {{ frontmatter: Record<string,string>, body: string, keyOrder: string[] }} parsed
 * @returns {string}
 */
export function renderFrontmatter({ frontmatter, body, keyOrder }) {
  const seen = new Set();
  const orderedKeys = [];
  for (const key of keyOrder) {
    if (Object.hasOwn(frontmatter, key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(frontmatter)) {
    if (!seen.has(key)) orderedKeys.push(key);
  }

  const fmLines = orderedKeys.map((key) => {
    const value = frontmatter[key];
    // Quote any value containing characters that would confuse our reader.
    const needsQuote = /[:#]/.test(value) || /^\s|\s$/.test(value);
    const rendered = needsQuote ? JSON.stringify(value) : value;
    return `${key}: ${rendered}`;
  });

  return [FRONTMATTER_FENCE, ...fmLines, FRONTMATTER_FENCE, body].join('\n');
}

/**
 * Extract unique candidate references from a memory entry body.
 *
 * @param {string} body
 * @returns {{ filePaths: string[], labels: string[], issues: number[] }}
 */
export function extractReferences(body) {
  const filePaths = new Set();
  const labels = new Set();
  const issues = new Set();

  if (typeof body !== 'string' || body.length === 0) {
    return { filePaths: [], labels: [], issues: [] };
  }

  for (const m of body.matchAll(FILE_PATH_REGEX)) {
    const candidate = m[1];
    // Filter pure label-shaped strings, anchor names, and trivially short
    // matches that are not real paths.
    if (candidate.includes('::')) continue;
    if (candidate.length < 4) continue;
    filePaths.add(candidate);
  }

  for (const m of body.matchAll(LABEL_REGEX)) {
    labels.add(m[1]);
  }

  for (const m of body.matchAll(ISSUE_REGEX)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n > 0) issues.add(n);
  }

  return {
    filePaths: [...filePaths],
    labels: [...labels],
    issues: [...issues],
  };
}

/**
 * Classify a non-zero `gh` exit into a confirmed-missing signal versus an
 * inconclusive/transient one. Only a positively-recognized "not found" (HTTP
 * 404 / "could not resolve to a …") counts as `missing`; everything else —
 * rate-limit, auth failure, network error, or any stderr we cannot positively
 * read as a 404 — is `unknown` so a transient outage never poisons an entry.
 *
 * @param {string} stderr
 * @returns {'missing' | 'unknown'}
 */
function classifyGhFailure(stderr) {
  const s = String(stderr ?? '');
  // Transient / non-authoritative failures never confirm a missing reference.
  if (
    /rate.?limit|\b429\b|\b403\b|\b401\b|authentic|unauthor|bad credentials|gh auth|login|token|network|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|could not resolve host|dial tcp|connection refused|no such host|TLS|handshake/i.test(
      s,
    )
  ) {
    return 'unknown';
  }
  // A genuine not-found is the only confirmed-missing signal.
  if (/not found|\b404\b|could not resolve to (?:an?|the)|no such/i.test(s)) {
    return 'missing';
  }
  // Anything else is inconclusive — never poison on an unrecognized failure.
  return 'unknown';
}

/**
 * Probe `gh` for an issue's existence and open/closed state. Resolves to one
 * of the three-valued shapes:
 *   - `{ status: 'exists', state: 'open' | 'closed' }`
 *   - `{ status: 'missing' }` — confirmed 404 (issue does not exist)
 *   - `{ status: 'unknown' }` — gh missing, spawn/child error, unparseable
 *     JSON, a transient (rate-limit/auth/network) failure, or a spawn that
 *     overran `timeoutMs` (the child is SIGKILL'd; never `missing`)
 *
 * Never throws.
 */
function probeIssue({
  number,
  ghPath,
  spawnImpl,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    if (!ghPath) {
      resolve({ status: 'unknown' });
      return;
    }
    let child;
    try {
      child = spawnImpl(
        ghPath,
        ['issue', 'view', String(number), '--json', 'state'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      resolve({ status: 'unknown' });
      return;
    }
    const settle = armProbeWatchdog({
      child,
      timeoutMs,
      resolve,
      onTimeout: { status: 'unknown' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', () => settle({ status: 'unknown' }));
    child.on('close', (code) => {
      if (code !== 0) {
        // Distinguish a confirmed 404 from a transient outage.
        settle({ status: classifyGhFailure(stderr) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (typeof parsed.state !== 'string') {
          settle({ status: 'unknown' });
          return;
        }
        settle({ status: 'exists', state: parsed.state.toLowerCase() });
      } catch {
        settle({ status: 'unknown' });
      }
    });
  });
}

/**
 * Probe `gh` for a label's existence. Resolves to one of:
 *   - `{ status: 'exists' }`
 *   - `{ status: 'missing' }` — confirmed 404 (label does not exist)
 *   - `{ status: 'unknown' }` — gh/owner/repo missing, spawn/child error, a
 *     transient (rate-limit/auth/network) failure, or a spawn that overran
 *     `timeoutMs` (the child is SIGKILL'd; never `missing`)
 *
 * Never throws.
 */
function probeLabel({
  name,
  owner,
  repo,
  ghPath,
  spawnImpl,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    if (!ghPath || !owner || !repo) {
      // No way to verify; cannot confirm existence or absence.
      resolve({ status: 'unknown' });
      return;
    }
    let child;
    try {
      child = spawnImpl(
        ghPath,
        ['api', `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      resolve({ status: 'unknown' });
      return;
    }
    const settle = armProbeWatchdog({
      child,
      timeoutMs,
      resolve,
      onTimeout: { status: 'unknown' },
    });
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', () => settle({ status: 'unknown' }));
    child.on('close', (code) => {
      if (code === 0) {
        settle({ status: 'exists' });
        return;
      }
      // Only a confirmed 404 marks the label missing; a transient failure
      // (rate-limit/auth/network) stays unknown and mutates nothing.
      settle({ status: classifyGhFailure(stderr) });
    });
  });
}

/**
 * Verify every candidate reference inside a single memory entry and collapse
 * the outcome into a three-valued freshness verdict:
 *   - `{ status: 'dead', reason }`  — at least one reference is confirmed
 *     missing (or a referenced issue is confirmed closed).
 *   - `{ status: 'alive' }`         — every reference is confirmed to exist.
 *   - `{ status: 'unknown' }`       — no confirmed-dead reference, but at least
 *     one probe was inconclusive, so recovery cannot be asserted.
 *
 * A confirmed-dead reference dominates (marks the entry stale even if other
 * probes are unknown); `alive` requires *every* reference positively confirmed
 * so an un-stale is only ever driven by positive evidence.
 *
 * @returns {Promise<{ status: 'dead' | 'alive' | 'unknown', reason?: string }>}
 */
async function verifyReferences({
  references,
  fsImpl,
  ghPath,
  spawnImpl,
  owner,
  repo,
  projectRoot,
  probeTimeoutMs,
}) {
  let sawUnknown = false;

  // Files resolve deterministically off the filesystem — never `unknown`.
  for (const filePath of references.filePaths) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);
    try {
      await fsImpl.access(resolved);
    } catch {
      return {
        status: 'dead',
        reason: `file reference no longer exists: ${filePath}`,
      };
    }
  }

  for (const number of references.issues) {
    const probe = await probeIssue({
      number,
      ghPath,
      spawnImpl,
      timeoutMs: probeTimeoutMs,
    });
    if (probe.status === 'missing') {
      return { status: 'dead', reason: `issue #${number} no longer exists` };
    }
    if (probe.status === 'exists' && probe.state === 'closed') {
      return { status: 'dead', reason: `issue #${number} is closed` };
    }
    if (probe.status === 'unknown') {
      sawUnknown = true;
    }
  }

  for (const labelName of references.labels) {
    const probe = await probeLabel({
      name: labelName,
      owner,
      repo,
      ghPath,
      spawnImpl,
      timeoutMs: probeTimeoutMs,
    });
    if (probe.status === 'missing') {
      return {
        status: 'dead',
        reason: `label "${labelName}" no longer exists`,
      };
    }
    if (probe.status === 'unknown') {
      sawUnknown = true;
    }
  }

  return sawUnknown ? { status: 'unknown' } : { status: 'alive' };
}

const STALE_KEYS = ['stale', 'staleReason', 'staleDetectedAt'];

/**
 * Return a copy of a parsed entry with the stale-marker keys stripped from
 * both the frontmatter map and the key order, preserving every other key and
 * the body verbatim.
 *
 * @param {{ frontmatter: Record<string,string>, body: string, keyOrder: string[] }} parsed
 * @returns {{ frontmatter: Record<string,string>, body: string, keyOrder: string[] }}
 */
function stripStaleKeys(parsed) {
  const frontmatter = { ...parsed.frontmatter };
  for (const key of STALE_KEYS) delete frontmatter[key];
  const keyOrder = parsed.keyOrder.filter((key) => !STALE_KEYS.includes(key));
  return { ...parsed, frontmatter, keyOrder };
}

/**
 * Whether a parsed entry currently carries the stale marker.
 *
 * @param {{ frontmatter: Record<string,string> }} parsed
 * @returns {boolean}
 */
function isStale(parsed) {
  return (
    parsed.frontmatter.stale === 'true' || parsed.frontmatter.stale === true
  );
}

/**
 * Scan a memory directory for stale entries.
 *
 * @param {object} opts
 * @param {string} opts.memoryDir — absolute path to the memory directory
 * @param {object} [opts.fsImpl] — node:fs/promises-compatible seam
 * @param {object} [opts.gitImpl] — reserved; not consumed today
 * @param {string} [opts.ghPath="gh"] — path to gh binary; pass empty/null to skip label/issue probes
 * @param {Function} [opts.spawnImpl] — child_process.spawn-compatible test seam
 * @param {string} [opts.projectRoot] — base for resolving relative file references; defaults to `process.cwd()`
 * @param {string} [opts.owner] — GitHub owner used for label probes
 * @param {string} [opts.repo]  — GitHub repo used for label probes
 * @param {string} [opts.now]   — ISO timestamp injector (test seam)
 * @param {number} [opts.probeTimeoutMs] — per-`gh`-spawn watchdog bound (ms);
 *   defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. A spawn that overruns is
 *   SIGKILL'd and resolves `unknown`, so a hung `gh` never marks an entry stale.
 * @returns {Promise<{
 *   scanned: number,
 *   staleEntries: Array<{ file: string, reason: string }>,
 *   unstaledEntries: Array<{ file: string }>,
 *   errors: Array<{ phase: string, file?: string, reason: string }>,
 * }>}
 */
export async function scanMemoryFreshness({
  memoryDir,
  fsImpl = defaultFs,
  gitImpl: _gitImpl,
  ghPath = 'gh',
  spawnImpl = defaultSpawn,
  projectRoot = process.cwd(),
  owner,
  repo,
  now,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const result = {
    scanned: 0,
    staleEntries: [],
    unstaledEntries: [],
    errors: [],
  };

  if (typeof memoryDir !== 'string' || memoryDir.length === 0) {
    result.errors.push({
      phase: 'discover',
      reason: 'memoryDir argument is missing or empty',
    });
    return result;
  }

  let entries;
  try {
    entries = await fsImpl.readdir(memoryDir);
  } catch (err) {
    result.errors.push({
      phase: 'discover',
      reason: `memory directory unreachable: ${err.message}`,
    });
    return result;
  }

  const markdownFiles = entries.filter((name) => name.endsWith('.md'));

  for (const name of markdownFiles) {
    const filePath = path.join(memoryDir, name);
    let raw;
    try {
      raw = await fsImpl.readFile(filePath, 'utf8');
    } catch (err) {
      result.errors.push({
        phase: 'read',
        file: name,
        reason: `read failed: ${err.message}`,
      });
      continue;
    }

    result.scanned += 1;

    let parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch (err) {
      result.errors.push({
        phase: 'parse',
        file: name,
        reason: `frontmatter parse failed: ${err.message}`,
      });
      continue;
    }

    let references;
    try {
      references = extractReferences(parsed.body);
    } catch (err) {
      result.errors.push({
        phase: 'extract',
        file: name,
        reason: `reference extraction failed: ${err.message}`,
      });
      continue;
    }

    let verdict;
    try {
      verdict = await verifyReferences({
        references,
        fsImpl,
        ghPath,
        spawnImpl,
        owner,
        repo,
        projectRoot,
        probeTimeoutMs,
      });
    } catch (err) {
      result.errors.push({
        phase: 'verify',
        file: name,
        reason: `verify failed: ${err.message}`,
      });
      continue;
    }

    const alreadyStale = isStale(parsed);

    // Reversible stale path (Story #4414): a previously-stale entry whose
    // references are now ALL confirmed alive is un-staled. `unknown` (a
    // transient probe) leaves the marker in place — recovery is only ever
    // asserted from positive evidence — and `dead` keeps it stale. Both the
    // still-dead and still-unknown cases fall through to a no-op, so a scan
    // over an unchanged memory dir is byte-identical (idempotent).
    if (alreadyStale) {
      if (verdict.status !== 'alive') continue;

      const rendered = renderFrontmatter(stripStaleKeys(parsed));
      const tmpPath = `${filePath}.unstale.tmp`;
      try {
        await fsImpl.writeFile(tmpPath, rendered, 'utf8');
        await fsImpl.rename(tmpPath, filePath);
      } catch (err) {
        result.errors.push({
          phase: 'write',
          file: name,
          reason: `atomic un-stale write failed: ${err.message}`,
        });
        continue;
      }
      result.unstaledEntries.push({ file: name });
      continue;
    }

    // A fresh entry is marked stale ONLY on a confirmed-dead reference; an
    // `unknown` verdict (transient gh outage) mutates nothing.
    if (verdict.status !== 'dead') continue;

    const stamped = {
      ...parsed,
      frontmatter: {
        ...parsed.frontmatter,
        stale: 'true',
        staleReason: verdict.reason,
        staleDetectedAt: now ?? new Date().toISOString(),
      },
    };

    const rendered = renderFrontmatter(stamped);
    const tmpPath = `${filePath}.stale.tmp`;
    try {
      await fsImpl.writeFile(tmpPath, rendered, 'utf8');
      await fsImpl.rename(tmpPath, filePath);
    } catch (err) {
      result.errors.push({
        phase: 'write',
        file: name,
        reason: `atomic write failed: ${err.message}`,
      });
      continue;
    }

    result.staleEntries.push({ file: name, reason: verdict.reason });
  }

  return result;
}

export default scanMemoryFreshness;
