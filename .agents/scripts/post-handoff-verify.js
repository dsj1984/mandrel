#!/usr/bin/env node

/**
 * .agents/scripts/post-handoff-verify.js
 *
 * Read-only post-flight for the v6.0.0 maintainer handoff (Story #1610
 * of Epic #1184). Runs two checks against the renamed GitHub repo:
 *
 *   1. HTTP HEAD on the legacy URL — expects a 301/302 redirect whose
 *      `Location` header points at the new repo slug.
 *   2. `git ls-remote` against the new HTTPS URL — confirms a clone /
 *      submodule sync would succeed without actually cloning.
 *
 * Both checks are read-only and idempotent: no files written, no repo
 * state mutated, no commits / tags / releases created. Re-running the
 * script any number of times produces the same exit code for the same
 * GitHub state.
 *
 * Exit codes:
 *   0  — both checks passed.
 *   1  — at least one check failed (details printed to stderr).
 *   2  — invalid CLI usage.
 *
 * Usage:
 *   node .agents/scripts/post-handoff-verify.js
 *   node .agents/scripts/post-handoff-verify.js --owner anthropics --repo mandrel
 *   node .agents/scripts/post-handoff-verify.js --old-repo agent-protocols
 *
 * Flags:
 *   --owner <login>      GitHub owner (default: anthropics)
 *   --repo <name>        Renamed repo (default: mandrel)
 *   --old-repo <name>    Legacy repo name to test redirect from
 *                        (default: agent-protocols)
 *   --json               Print a single JSON envelope to stdout instead
 *                        of human-readable lines.
 *   -h, --help           Print this help.
 *
 * Design notes:
 *   - Uses the global `fetch` (Node ≥ 18) with `redirect: 'manual'` so
 *     we can observe the 301 rather than silently following it.
 *   - Uses `git ls-remote` (local binary) to validate the new URL is
 *     reachable. `ls-remote` is a read-only Git operation — it lists
 *     refs without downloading objects.
 *   - No authentication required; both checks hit public surfaces.
 */

// cli-opt-out: thin async main wrapper with explicit exit-code mapping;
// runAsCli's JSON envelope convention doesn't fit this script's two-line
// human-readable / single-JSON-blob output modes. See `--json` flag.
import { spawnSync } from 'node:child_process';
import { argv, exit, stderr, stdout } from 'node:process';

const DEFAULT_OWNER = 'anthropics';
const DEFAULT_NEW_REPO = 'mandrel';
const DEFAULT_OLD_REPO = 'agent-protocols';

function parseArgs(rawArgs) {
  const args = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_NEW_REPO,
    oldRepo: DEFAULT_OLD_REPO,
    json: false,
    help: false,
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const flag = rawArgs[i];
    if (flag === '-h' || flag === '--help') {
      args.help = true;
    } else if (flag === '--json') {
      args.json = true;
    } else if (flag === '--owner') {
      args.owner = rawArgs[i + 1];
      i += 1;
    } else if (flag === '--repo') {
      args.repo = rawArgs[i + 1];
      i += 1;
    } else if (flag === '--old-repo') {
      args.oldRepo = rawArgs[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (!args.owner || !args.repo || !args.oldRepo) {
    throw new Error('owner, repo, and old-repo are all required');
  }
  return args;
}

function printHelp() {
  stdout.write(
    [
      'post-handoff-verify.js — read-only v6 handoff verification',
      '',
      'Usage:',
      '  node .agents/scripts/post-handoff-verify.js [flags]',
      '',
      'Flags:',
      '  --owner <login>      GitHub owner (default: anthropics)',
      '  --repo <name>        Renamed repo (default: mandrel)',
      '  --old-repo <name>    Legacy repo name (default: agent-protocols)',
      '  --json               Emit JSON envelope to stdout',
      '  -h, --help           Print this help',
      '',
    ].join('\n'),
  );
}

/**
 * HTTP HEAD on the legacy repo URL with manual redirect handling.
 * Returns `{ ok, status, location, error }`.
 */
async function checkRedirect(owner, oldRepo, newRepo) {
  const url = `https://github.com/${owner}/${oldRepo}`;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const status = res.status;
    const location = res.headers.get('location') || null;
    if (status >= 300 && status < 400 && location) {
      const ok = location.includes(`/${newRepo}`);
      return {
        ok,
        status,
        location,
        error: ok ? null : `redirect Location does not contain /${newRepo}`,
      };
    }
    return {
      ok: false,
      status,
      location,
      error: `expected 3xx redirect, got ${status}`,
    };
  } catch (err) {
    return { ok: false, status: null, location: null, error: err.message };
  }
}

/**
 * Spawn `git ls-remote` against the new HTTPS URL. Read-only — lists
 * refs without downloading objects.
 */
function checkLsRemote(owner, newRepo) {
  const url = `https://github.com/${owner}/${newRepo}.git`;
  const res = spawnSync('git', ['ls-remote', '--heads', url], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) {
    return { ok: false, url, error: res.error.message };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      url,
      error: `git ls-remote exited ${res.status}: ${(res.stderr || '').trim()}`,
    };
  }
  const refCount = (res.stdout || '')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
  if (refCount === 0) {
    return { ok: false, url, error: 'git ls-remote returned no refs' };
  }
  return { ok: true, url, refCount, error: null };
}

async function main(rawArgs) {
  let args;
  try {
    args = parseArgs(rawArgs);
  } catch (err) {
    stderr.write(`post-handoff-verify: ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const redirect = await checkRedirect(args.owner, args.oldRepo, args.repo);
  const lsRemote = checkLsRemote(args.owner, args.repo);
  const ok = redirect.ok && lsRemote.ok;
  const envelope = {
    ok,
    owner: args.owner,
    repo: args.repo,
    oldRepo: args.oldRepo,
    redirect,
    lsRemote,
  };

  if (args.json) {
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    stdout.write(
      `redirect ${args.oldRepo} → ${args.repo}: ${
        redirect.ok ? 'OK' : 'FAIL'
      }${redirect.status ? ` (status=${redirect.status})` : ''}${
        redirect.location ? ` → ${redirect.location}` : ''
      }${redirect.error ? ` — ${redirect.error}` : ''}\n`,
    );
    stdout.write(
      `git ls-remote ${lsRemote.url}: ${lsRemote.ok ? 'OK' : 'FAIL'}${
        lsRemote.refCount ? ` (${lsRemote.refCount} heads)` : ''
      }${lsRemote.error ? ` — ${lsRemote.error}` : ''}\n`,
    );
  }
  return ok ? 0 : 1;
}

main(argv.slice(2)).then(
  (code) => exit(code),
  (err) => {
    stderr.write(
      `post-handoff-verify: unexpected error: ${err.stack || err.message}\n`,
    );
    exit(1);
  },
);
