// tests/e2e/helpers/local-registry.js
/**
 * Minimal loopback npm registry for the `mandrel update` real-chain e2e
 * (Story #4126, under Epic #4118 — test-health remediation).
 *
 * `mandrel update` resolves its target version by shelling
 * `npm view mandrel version` (`lib/cli/update.js#defaultVersionRunner`). That
 * probe hits whatever registry `npm` is configured to use. To drive the **real**
 * update chain **offline and deterministically**, the e2e points npm at this
 * loopback server (via `npm_config_registry`) instead of the live registry: it
 * serves exactly two routes for the single `mandrel` package, backed by a
 * tarball this repo packed itself.
 *
 * ## Routes
 *
 *   GET /mandrel             → the **packument** JSON. `npm view mandrel version`
 *                             reads `dist-tags.latest`, resolves it to the
 *                             matching entry in the `versions` map, and prints
 *                             that entry's `version`. (A dist-tags-only document
 *                             is NOT enough — npm dereferences the version map,
 *                             so the map must carry a real manifest.)
 *   GET /mandrel/-/<tgz>     → the raw bytes of the packed tarball, the same
 *                             artifact `npm install mandrel@<v>` would download.
 *
 * The install step of the e2e does NOT route through this registry — it uses
 * `mandrel update --install-cmd "npm install --offline … <tarball>"` so the
 * dependency tree resolves from the local npm cache with zero network. This
 * server therefore only has to satisfy the `npm view` probe, but it serves the
 * tarball too so the design stays honest (a registry-route install would also
 * work against it for the `mandrel` package itself).
 *
 * ## Why loopback, not a fake
 *
 * The point of the e2e is to exercise the **real** `npm view` boundary the
 * production binary uses — not a seam. A loopback HTTP server bound to
 * `127.0.0.1` is offline (no DNS, no WAN), deterministic (the version is fixed
 * by the caller), and exercises the genuine spawn → npm → HTTP → parse path.
 *
 * Security (security-baseline § Transport & Headers): binds to `127.0.0.1`
 * only, serves a fixed package name + a caller-provided tarball, reads no
 * secrets, and is torn down by the returned `close()`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

/** The only package this loopback registry knows about. */
const PACKAGE_NAME = 'mandrel';

/**
 * Build the packument document `npm view` dereferences. The version entry is
 * the real manifest extracted from the tarball (so published metadata is
 * faithful), with its `version` pinned to `version` and a `dist` block whose
 * `tarball` URL points back at this server.
 *
 * @param {object} params
 * @param {string} params.version - The version to advertise as `latest`.
 * @param {object} params.manifest - The package manifest (from the tarball).
 * @param {Buffer} params.tarballBuf - The tarball bytes (for integrity digests).
 * @param {string} params.tarballUrl - Absolute URL this server serves the tgz at.
 * @returns {object} The packument JSON object.
 */
function buildPackument({ version, manifest, tarballBuf, tarballUrl }) {
  const shasum = crypto.createHash('sha1').update(tarballBuf).digest('hex');
  const integrity = `sha512-${crypto
    .createHash('sha512')
    .update(tarballBuf)
    .digest('base64')}`;

  const versionManifest = {
    ...manifest,
    version,
    dist: { tarball: tarballUrl, shasum, integrity },
  };

  return {
    name: PACKAGE_NAME,
    'dist-tags': { latest: version },
    versions: { [version]: versionManifest },
  };
}

/**
 * Start a loopback npm registry that advertises `mandrel@<version>` and serves
 * the given tarball. Resolves once the server is listening.
 *
 * @param {object} params
 * @param {string} params.tarballPath - Absolute path to the packed `.tgz`.
 * @param {string} params.version - The version to advertise as `latest`.
 * @param {object} params.manifest - The package manifest (parsed from the
 *   tarball's `package/package.json`), used to make the packument faithful.
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   requests: string[],
 *   close: () => Promise<void>,
 * }>}
 *   `url` — the registry base URL (`http://127.0.0.1:<port>`).
 *   `requests` — every request path the server received (for assertions).
 *   `close` — stops the server (await before the test ends).
 */
export function startLocalRegistry({ tarballPath, version, manifest }) {
  const tarballBuf = fs.readFileSync(tarballPath);
  const tarballFile = `${PACKAGE_NAME}-${version}.tgz`;
  const tarballRoute = `/${PACKAGE_NAME}/-/${tarballFile}`;
  /** @type {string[]} */
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);

    if (url === `/${PACKAGE_NAME}` || url === `/${PACKAGE_NAME}/`) {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const tarballUrl = `http://127.0.0.1:${port}${tarballRoute}`;
      const packument = buildPackument({
        version,
        manifest,
        tarballBuf,
        tarballUrl,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(packument));
      return;
    }

    if (url === tarballRoute) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tarballBuf);
      return;
    }

    res.statusCode = 404;
    res.end(`local-registry: not found: ${url}`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
