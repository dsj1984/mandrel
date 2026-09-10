/**
 * bootstrap/baseline-merge-driver — register the `baselines/*.json` merge
 * driver on a consumer clone (Story #5215).
 *
 * Registration has two halves that live in different places, and conflating
 * them is why this needs a doctor check rather than just an installer:
 *
 *   1. **`.gitattributes`** says which files use the driver. It is a tracked
 *      file, so installing the line once ships it to everyone.
 *   2. **`git config merge.mandrel-baseline.driver`** says what the driver
 *      actually is. Git deliberately keeps this out of tracked config —
 *      otherwise a clone would execute a command chosen by whoever wrote the
 *      repo — so it is **per clone**, and a fresh clone silently falls back
 *      to git's text merge with no error at all.
 *
 * That silence is the whole reason `mandrel doctor` carries a check: an
 * unregistered clone is not broken in any way it can report on its own, it
 * just quietly goes back to conflicting (or worse, splicing) baselines.
 *
 * This module owns both halves plus the strings they share, so the installer
 * and the doctor check cannot drift apart on the exact command.
 *
 * @module lib/bootstrap/baseline-merge-driver
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from '../child-exec.js';

/** Driver name, as it appears on both sides of the registration. */
const BASELINE_MERGE_DRIVER_NAME = 'mandrel-baseline';

/** The `.gitattributes` line that routes baselines through the driver. */
const BASELINE_MERGE_ATTRIBUTE = `baselines/*.json merge=${BASELINE_MERGE_DRIVER_NAME}`;

/** Git config key holding the driver command. */
export const BASELINE_MERGE_DRIVER_CONFIG_KEY = `merge.${BASELINE_MERGE_DRIVER_NAME}.driver`;

/** Script path the driver command invokes, relative to the worktree root. */
const DRIVER_SCRIPT = '.agents/scripts/merge-baseline.js';

/** Git's merge-driver placeholders, in the order the driver's argv expects. */
const DRIVER_PLACEHOLDERS = '%O %A %B %P';

/**
 * Build the driver command for a given node binary.
 *
 * The interpreter is the RESOLVED ABSOLUTE path (`process.execPath`), not the
 * bare word `node`, and it is quoted. Git runs a merge driver through the
 * shell, and that shell's `PATH` is whatever launched git — a GUI client, a
 * Finder-launched editor, a `launchd` job — none of which necessarily carry
 * the nvm/volta shim that puts `node` on an interactive shell's `PATH`. A
 * driver that cannot start is not a loud failure: git reports the driver
 * exited non-zero and falls back to leaving the file conflicted, which reads
 * as "baselines conflict again" — the exact symptom the driver exists to
 * remove. Quoting covers the installation whose node lives under a path with
 * a space (`/Users/a b/.nvm/...`).
 *
 * The script path stays RELATIVE: git runs the driver from the worktree root,
 * and that is also where `mandrel sync` materializes `.agents/`, so one
 * command is correct in the main checkout and in every linked worktree.
 *
 * @param {string} [execPath] Absolute path to the node binary.
 * @returns {string}
 */
function buildBaselineMergeDriverCommand(execPath = process.execPath) {
  return `"${execPath}" ${DRIVER_SCRIPT} ${DRIVER_PLACEHOLDERS}`;
}

/** The driver command this process would install. */
const BASELINE_MERGE_DRIVER_COMMAND = buildBaselineMergeDriverCommand();

/**
 * The exact command an operator runs to complete registration. Single-quoted
 * because the command itself carries the double quotes around the node path.
 */
export const BASELINE_MERGE_DRIVER_REMEDY = `git config ${BASELINE_MERGE_DRIVER_CONFIG_KEY} '${BASELINE_MERGE_DRIVER_COMMAND}'`;

/**
 * Split a configured driver command into an executable + argv pair, dropping
 * git's `%O %A %B %P` placeholders.
 *
 * Used by the `mandrel doctor` check to actually RUN the configured command
 * (with `--help`) rather than only assert the config key is non-empty. A key
 * pointing at a node that no longer exists — the ordinary outcome of an nvm
 * version bump after the driver was installed — is set, non-empty, and
 * completely broken, and the pre-Story-#5277 check called that healthy.
 *
 * Tokenising here rather than handing the string to a shell is deliberate:
 * the value is per-clone git config, and executing it through `shell: true`
 * would turn any write to that key into arbitrary command execution
 * (`security-baseline.md` § Output & Rendering — never concatenate into a
 * shell command). Only double quotes are honoured, which is exactly the
 * quoting {@link buildBaselineMergeDriverCommand} emits.
 *
 * @param {string|null|undefined} command
 * @returns {{ file: string, args: string[] }|null} null when there is no
 *   runnable first token.
 */
export function parseBaselineMergeDriverCommand(command) {
  const tokens = String(command ?? '').match(/"[^"]*"|\S+/g) ?? [];
  const cleaned = tokens
    .map((token) =>
      token.startsWith('"') && token.endsWith('"') && token.length >= 2
        ? token.slice(1, -1)
        : token,
    )
    .filter((token) => token.length > 0 && !/^%[A-Za-z]$/.test(token));
  if (cleaned.length === 0) return null;
  const [file, ...args] = cleaned;
  return { file, args };
}

/**
 * Does this `.gitattributes` content route baselines through the driver?
 * Comment lines do not count — a commented-out registration is not one.
 *
 * @param {string|null|undefined} gitattributes
 * @returns {boolean}
 */
export function declaresBaselineMergeDriver(gitattributes) {
  return String(gitattributes ?? '')
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      return trimmed.includes(`merge=${BASELINE_MERGE_DRIVER_NAME}`);
    });
}

/**
 * Is the driver DECLARED by this project and REGISTERED in this clone?
 *
 * Two callers ask this exact question of two different clones — the
 * `mandrel doctor` check, and the pre-push base-sync guard — and both need
 * the same two-part answer, because the two halves fail differently:
 *
 *   - **Not declared** → the project never opted in. Both callers stay
 *     silent; telling a consumer to register a driver for files they do not
 *     route through it is noise. An unreadable `.gitattributes` reads the
 *     same way, deliberately.
 *   - **Declared, empty command** → the silent case. Git reports nothing at
 *     all: it falls back to its own line-based merge, which on a generated
 *     baseline either conflicts on the `generatedAt` stamp or splices both
 *     sides' rows into a set neither side scored.
 *
 * The `runGit` seam takes argv tokens and returns `{ status, stdout }`, which
 * is the shape both callers' own git surfaces already produce.
 *
 * @param {{
 *   projectRoot: string,
 *   fsImpl?: typeof fs,
 *   runGit: (args: string[]) => { status?: number|null, stdout?: unknown },
 * }} ctx
 * @returns {{ declared: boolean, command: string }}
 */
export function probeBaselineMergeDriver({ projectRoot, fsImpl = fs, runGit }) {
  let attributes = '';
  try {
    attributes = fsImpl.readFileSync(
      path.join(projectRoot, '.gitattributes'),
      'utf8',
    );
  } catch {
    attributes = '';
  }
  if (!declaresBaselineMergeDriver(attributes)) {
    return { declared: false, command: '' };
  }
  const configured = runGit([
    'config',
    '--get',
    BASELINE_MERGE_DRIVER_CONFIG_KEY,
  ]);
  const command =
    configured?.status === 0 ? String(configured.stdout ?? '').trim() : '';
  return { declared: true, command };
}

/**
 * Add the attribute line, preserving every existing line verbatim.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {{ action: 'created'|'appended'|'already-present', path: string }}
 */
function ensureGitattributesLine(projectRoot, fsImpl = fs) {
  const target = path.join(projectRoot, '.gitattributes');
  if (!fsImpl.existsSync(target)) {
    fsImpl.writeFileSync(target, `${BASELINE_MERGE_ATTRIBUTE}\n`, 'utf8');
    return { action: 'created', path: target };
  }
  const existing = fsImpl.readFileSync(target, 'utf8');
  if (declaresBaselineMergeDriver(existing)) {
    return { action: 'already-present', path: target };
  }
  // A file not ending in a newline would otherwise glue our line onto the
  // last existing one, silently rewriting it.
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fsImpl.writeFileSync(
    target,
    `${existing}${separator}${BASELINE_MERGE_ATTRIBUTE}\n`,
    'utf8',
  );
  return { action: 'appended', path: target };
}

/**
 * Point `merge.mandrel-baseline.driver` at the driver in THIS clone.
 *
 * @param {string} projectRoot
 * @param {typeof spawnCapture} [spawnImpl]
 * @returns {{ action: 'set'|'already-present'|'not-a-repo'|'failed' }}
 */
function ensureDriverGitConfig(projectRoot, spawnImpl = spawnCapture) {
  const opts = {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: false,
  };
  const inRepo = spawnImpl('git', ['rev-parse', '--git-dir'], opts);
  if ((inRepo?.status ?? 1) !== 0) return { action: 'not-a-repo' };

  const current = spawnImpl(
    'git',
    ['config', '--local', '--get', BASELINE_MERGE_DRIVER_CONFIG_KEY],
    opts,
  );
  if (
    (current?.status ?? 1) === 0 &&
    String(current.stdout ?? '').trim() === BASELINE_MERGE_DRIVER_COMMAND
  ) {
    return { action: 'already-present' };
  }

  const set = spawnImpl(
    'git',
    [
      'config',
      '--local',
      BASELINE_MERGE_DRIVER_CONFIG_KEY,
      BASELINE_MERGE_DRIVER_COMMAND,
    ],
    opts,
  );
  spawnImpl(
    'git',
    [
      'config',
      '--local',
      `merge.${BASELINE_MERGE_DRIVER_NAME}.name`,
      'mandrel baseline merge by row identity',
    ],
    opts,
  );
  return { action: (set?.status ?? 1) === 0 ? 'set' : 'failed' };
}

/**
 * Read `.gitattributes` without writing it — the `configOnly` half of
 * {@link ensureBaselineMergeDriver}.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {{ action: 'already-present'|'absent', path: string }}
 */
function probeGitattributesLine(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.gitattributes');
  let existing = '';
  try {
    existing = fsImpl.readFileSync(target, 'utf8');
  } catch {
    existing = '';
  }
  return {
    action: declaresBaselineMergeDriver(existing)
      ? 'already-present'
      : 'absent',
    path: target,
  };
}

/**
 * Install the registration. Idempotent: a second run reports
 * `already-present` and changes no bytes.
 *
 * Two modes, because the two callers mean different things by "install":
 *
 * - **Full (default)** — `mandrel init --with-quality` and this repo's own
 *   `prepare`. Writes the `.gitattributes` line as well as the config key:
 *   the caller has opted the repository into the quality surface, so
 *   declaring the attribute is part of what it asked for.
 * - **`configOnly: true`** — consumer `mandrel sync`. Writes ONLY the
 *   per-clone config key, and only when `.gitattributes` already declares the
 *   attribute. `sync` materializes `.agents/`; it is not an opt-in to the
 *   quality surface, and creating a `.gitattributes` in a project that never
 *   asked for one would be `sync` changing git's behaviour on files it has no
 *   business touching. What it DOES fix is the real gap: the attribute is
 *   tracked and therefore ships with the repo, while the config key is
 *   per-clone and silently absent in every fresh clone — so the half that
 *   cannot travel is installed on the one command every consumer runs.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {boolean} [ctx.configOnly]
 * @param {typeof spawnCapture} [ctx.spawnImpl]
 * @param {typeof fs} [ctx.fsImpl]
 * @returns {{
 *   action: 'already-present'|'updated'|'skipped',
 *   attributes: string,
 *   config: string,
 *   path: string,
 *   line: string,
 *   command: string,
 * }}
 */
export function ensureBaselineMergeDriver(ctx) {
  const fsImpl = ctx.fsImpl ?? fs;
  const attributes = ctx.configOnly
    ? probeGitattributesLine(ctx.projectRoot, fsImpl)
    : ensureGitattributesLine(ctx.projectRoot, fsImpl);
  const base = {
    attributes: attributes.action,
    path: attributes.path,
    line: BASELINE_MERGE_ATTRIBUTE,
    command: BASELINE_MERGE_DRIVER_COMMAND,
  };
  if (attributes.action === 'absent') {
    return { ...base, action: 'skipped', config: 'skipped' };
  }
  const config = ensureDriverGitConfig(ctx.projectRoot, ctx.spawnImpl);
  const settled =
    attributes.action === 'already-present' &&
    (config.action === 'already-present' || config.action === 'not-a-repo');
  return {
    ...base,
    action: settled ? 'already-present' : 'updated',
    config: config.action,
  };
}
