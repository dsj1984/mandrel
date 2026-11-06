/**
 * coverage-ratchet.js — CI's hand-back for a coverage capture deferred to CI.
 * Adopt a CI-produced Istanbul artifact at the checked-out HEAD (placed at
 * the configured coverage path and stamped exactly as a green local capture
 * is), then score the per-file coverage and CRAP value ratchet over it.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  computeContentDigest,
  computeTreeDigest,
  writeCaptureStamp,
} from './coverage-capture.js';
import { readHeadCommit } from './coverage-capture-delta.js';
import { captureGates } from './coverage-capture-passes.js';
import { gitSpawn } from './git-utils.js';

/** The `--scope` values: what the artifact measured. */
const SCOPES = new Set(['affected', 'full']);

/**
 * @param {string[]} argv `process.argv.slice(2)`.
 * @returns {{ artifact: string|null, head: string|null, scope: string, base: string|null, adoptOnly: boolean, error?: string }}
 */
export function parseRatchetArgs(argv) {
  const out = {
    artifact: null,
    head: null,
    scope: 'affected',
    base: null,
    adoptOnly: false,
  };
  const valued = {
    '--artifact': 'artifact',
    '--head': 'head',
    '--scope': 'scope',
    '--base': 'base',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--adopt-only') out.adoptOnly = true;
    else if (valued[argv[i]]) out[valued[argv[i]]] = argv[++i] ?? null;
  }
  return { ...out, ...argError(out) };
}

/** @returns {{ error?: string }} */
function argError({ artifact, head, scope }) {
  if (!artifact || !head)
    return { error: '--artifact and --head are required' };
  if (!SCOPES.has(scope))
    return { error: `--scope must be affected or full, got "${scope}"` };
  return {};
}

/** Tracked files with uncommitted changes, from `git status --porcelain`. */
function dirtyTracked(cwd, git) {
  const res = git(cwd, 'status', '--porcelain', '--untracked-files=no');
  if (res.status !== 0) return ['(git status failed)'];
  return res.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/** Why `artifact` cannot be adopted as Istanbul JSON, else `null`. */
function unreadableArtifact(artifact) {
  try {
    const parsed = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? null
      : 'is not an Istanbul coverage-final.json object';
  } catch (err) {
    return `cannot be read as JSON (${err?.code ?? err?.message ?? err})`;
  }
}

/**
 * The first reason the artifact may not be adopted here, else `null`: the
 * declared head is not HEAD, a tracked file is dirty, or the artifact is
 * missing or unparseable.
 */
function adoptRefusal({ cwd, artifact, head, git, readHead }) {
  const actual = readHead(cwd);
  if (!actual || actual !== head) {
    return `--head ${head} is not the checked-out HEAD (${actual ?? 'unreadable'}) — check out the ref the artifact was produced at`;
  }
  const dirty = dirtyTracked(cwd, git);
  if (dirty.length > 0) {
    return `tracked files are dirty, so the tree is not the one the artifact measured: ${dirty.join(', ')}`;
  }
  const unreadable = unreadableArtifact(artifact);
  return unreadable ? `artifact ${artifact} ${unreadable}` : null;
}

/**
 * Place the artifact at the configured coverage path and write the standard
 * capture stamp for this tree, so every updater reads it as a green capture
 * at HEAD. Returns the refusal reason, else `null`.
 *
 * @param {{ cwd: string, quality: { crap: object, coverage: object }, artifact: string, head: string, scope: 'affected'|'full', base: string, git?: Function, readHead?: Function }} opts
 * @returns {string|null}
 */
export function adoptArtifact({
  cwd,
  quality,
  artifact,
  head,
  scope,
  base,
  git = gitSpawn,
  readHead = readHeadCommit,
}) {
  const source = path.resolve(cwd, artifact);
  const refusal = adoptRefusal({ cwd, artifact: source, head, git, readHead });
  if (refusal) return refusal;
  const { crap, coverage } = captureGates(quality);
  const target = path.resolve(cwd, coverage.coveragePath);
  if (target !== source) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const written = writeCaptureStamp({
    cwd,
    coveragePath: coverage.coveragePath,
    digest: computeContentDigest(cwd, crap.targetDirs),
    treeDigest: computeTreeDigest(cwd, coverage.coveragePath),
    commit: head,
    ...(scope === 'affected' ? { scope, ref: base } : {}),
  });
  return written
    ? null
    : `no capture stamp could be written for ${coverage.coveragePath}`;
}

/**
 * The value ratchet over the adopted artifact, in order: the changed files'
 * coverage rows (working copy only), the CRAP preview, then the coverage and
 * CRAP baselines gate.
 *
 * @param {string} scriptsDir @param {string} base
 * @returns {Array<{ step: string, args: string[], env?: Record<string, string> }>}
 */
export function ratchetSteps(scriptsDir, base) {
  const script = (name) => path.join(scriptsDir, name);
  return [
    {
      step: 'update-coverage-baseline',
      args: [script('update-coverage-baseline.js'), '--diff-scope', base],
    },
    {
      step: 'quality-preview-crap',
      args: [
        script('quality-preview.js'),
        '--only',
        'crap',
        '--changed-since',
        base,
      ],
    },
    {
      step: 'check-baselines',
      args: [
        script('check-baselines.js'),
        '--gate',
        'coverage,crap',
        '--format',
        'text',
      ],
      env: { BASELINE_REF: base },
    },
  ];
}

/**
 * Run each step with `run(args, env)`; the first non-zero exit is the
 * failure, named.
 *
 * @param {ReturnType<typeof ratchetSteps>} steps
 * @param {(args: string[], env?: Record<string, string>) => Promise<number>|number} run
 * @returns {Promise<{ failedStep: string|null, status: number }>}
 */
export async function scoreRatchet(steps, run) {
  for (const { step, args, env } of steps) {
    const status = await run(args, env);
    if (status !== 0) return { failedStep: step, status };
  }
  return { failedStep: null, status: 0 };
}
