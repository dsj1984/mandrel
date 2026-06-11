/**
 * memory-freshness.js — walker + verifier for the `/plan` Phase 0
 * memory-freshness pre-flight. Story #2557 / Epic #2547. Tech Spec #2550.
 *
 * Walks every `.md` file under a memory directory (typically
 * `~/.claude/projects/<repo>/memory/`), parses the YAML frontmatter, extracts
 * candidate references (file paths, GitHub labels, GitHub issue numbers),
 * verifies each, and rewrites the frontmatter with `stale: true`,
 * `staleReason: "..."`, `staleDetectedAt: "<iso>"` when any reference is dead.
 *
 * The walker is idempotent: entries already marked `stale: true` are skipped
 * untouched, so a subsequent run does not re-flag or thrash the frontmatter.
 *
 * Best-effort guarantees:
 * - The memory directory missing yields `{ scanned: 0, staleEntries: [],
 *   errors: [{ phase: 'discover', reason: '...' }] }` and no throw.
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
 * Probe `gh` for an issue's open/closed state. Resolves to one of:
 *   - `{ exists: true, state: 'open' | 'closed' }`
 *   - `{ exists: false }` — gh missing or probe failed (best-effort skip)
 *   - `{ exists: true, state: 'unknown' }` — couldn't parse JSON
 *
 * Never throws.
 */
function probeIssue({ number, ghPath, spawnImpl }) {
  return new Promise((resolve) => {
    if (!ghPath) {
      resolve({ exists: false });
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
      resolve({ exists: false });
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => resolve({ exists: false }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ exists: false });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        const state =
          typeof parsed.state === 'string'
            ? parsed.state.toLowerCase()
            : 'unknown';
        resolve({ exists: true, state });
      } catch {
        resolve({ exists: true, state: 'unknown' });
      }
    });
  });
}

/**
 * Probe `gh` for a label's existence. Resolves to:
 *   - `{ exists: true }`
 *   - `{ exists: false }` (label not found OR gh missing — best-effort skip)
 *
 * Never throws.
 */
function probeLabel({ name, owner, repo, ghPath, spawnImpl }) {
  return new Promise((resolve) => {
    if (!ghPath || !owner || !repo) {
      // No way to verify; treat as best-effort skip (existing).
      resolve({ exists: true, probed: false });
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
      resolve({ exists: true, probed: false });
      return;
    }
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', () => resolve({ exists: true, probed: false }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ exists: true, probed: true });
        return;
      }
      if (/not found/i.test(stderr) || code === 1) {
        resolve({ exists: false, probed: true });
        return;
      }
      // Any other failure → best-effort skip.
      resolve({ exists: true, probed: false });
    });
  });
}

/**
 * Verify the candidate references inside a single memory entry. Returns the
 * first dead-reference reason discovered, or `null` if everything checks out.
 *
 * @returns {Promise<string|null>}
 */
async function findFirstDeadReason({
  references,
  fsImpl,
  ghPath,
  spawnImpl,
  owner,
  repo,
  projectRoot,
}) {
  for (const filePath of references.filePaths) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRoot, filePath);
    try {
      await fsImpl.access(resolved);
    } catch {
      return `file reference no longer exists: ${filePath}`;
    }
  }

  if (ghPath) {
    for (const number of references.issues) {
      const probe = await probeIssue({ number, ghPath, spawnImpl });
      if (probe.exists && probe.state === 'closed') {
        return `issue #${number} is closed`;
      }
    }
    for (const labelName of references.labels) {
      const probe = await probeLabel({
        name: labelName,
        owner,
        repo,
        ghPath,
        spawnImpl,
      });
      if (probe.probed && !probe.exists) {
        return `label "${labelName}" no longer exists`;
      }
    }
  }

  return null;
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
 * @returns {Promise<{
 *   scanned: number,
 *   staleEntries: Array<{ file: string, reason: string }>,
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
} = {}) {
  const result = { scanned: 0, staleEntries: [], errors: [] };

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

    // Idempotent: already-stale entries are left untouched.
    if (
      parsed.frontmatter.stale === 'true' ||
      parsed.frontmatter.stale === true
    ) {
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

    let reason;
    try {
      reason = await findFirstDeadReason({
        references,
        fsImpl,
        ghPath,
        spawnImpl,
        owner,
        repo,
        projectRoot,
      });
    } catch (err) {
      result.errors.push({
        phase: 'verify',
        file: name,
        reason: `verify failed: ${err.message}`,
      });
      continue;
    }

    if (!reason) continue;

    const stamped = {
      ...parsed,
      frontmatter: {
        ...parsed.frontmatter,
        stale: 'true',
        staleReason: reason,
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

    result.staleEntries.push({ file: name, reason });
  }

  return result;
}

export default scanMemoryFreshness;
