/**
 * inherited-failure.js — is a red PR failing for its own reasons, or for one
 * it shares with the base branch or with an unrelated PR? Pure.
 */

const SIGNATURE_MAX = 120;

/**
 * A failure signature: the check name plus its first failure annotation.
 *
 * @param {{ name: string, note?: string|null }} check
 * @returns {string}
 */
export function failureSignature(check) {
  const sig = check.note ? `${check.name}: ${check.note}` : check.name;
  return sig.replace(/\s+/g, ' ').slice(0, SIGNATURE_MAX);
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sharesPath(a, b) {
  const seen = new Set(a);
  return b.some((p) => seen.has(p));
}

/**
 * A PR's failure is inherited when its signature is red on the base branch,
 * or red on another PR that changes none of the same paths.
 *
 * @param {Array<{ number: number, sigs: string[], paths: string[] }>} prs
 * @param {string[]} baseSigs
 * @returns {{ inheritedPrs: Set<number>,
 *   inherited: Array<{ sig: string, onBase: boolean, prs: number[] }> }}
 */
export function findInherited(prs, baseSigs) {
  const onBase = new Set(baseSigs);
  const bySig = new Map();
  for (const pr of prs) {
    for (const sig of pr.sigs) {
      if (!onBase.has(sig) && !isSharedWithUnrelated(pr, sig, prs)) continue;
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(pr.number);
    }
  }
  const inherited = [...bySig].map(([sig, numbers]) => ({
    sig,
    onBase: onBase.has(sig),
    prs: numbers,
  }));
  return {
    inheritedPrs: new Set(inherited.flatMap((entry) => entry.prs)),
    inherited,
  };
}

function isSharedWithUnrelated(pr, sig, prs) {
  return prs.some(
    (other) =>
      other.number !== pr.number &&
      other.sigs.includes(sig) &&
      !sharesPath(pr.paths, other.paths),
  );
}
