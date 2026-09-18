/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

/**
 * `delivery.quality.gates.crap.incrementalCoverage`; the two switches stay
 * independent because only `baselineJoin` loosens the gate.
 */
export const INCREMENTAL_COVERAGE_SCHEMA = {
  type: 'object',
  description:
    'The two independent full-suite economies (Story #4981, split by Story #5173). `skipWhenUnchanged` (default true) decides WHETHER to capture — no changed file under `crap.targetDirs` versus `baseRef` means no capture at all — and is a pure saving. `baselineJoin` (default false) loosens gate semantics: the CRAP join resolves a method in an untouched file from its committed baseline row instead of requiring fresh coverage for it. Neither narrows the capture run itself: a capture that does happen is the ordinary full `npm run test:coverage` (Story #5065).',
  properties: {
    skipWhenUnchanged: {
      type: 'boolean',
      description:
        'Skip the capture entirely when no changed file under `crap.targetDirs` versus `baseRef` was touched. The only measured saving, and gate-semantics-neutral. Defaults to true.',
      default: true,
    },
    baselineJoin: {
      type: 'boolean',
      description:
        'Let the CRAP join resolve a method in a file the diff did not touch from its committed baseline row instead of requiring fresh coverage for it. A gate loosening, not a saving — defaults to false.',
      default: false,
    },
    baseRef: {
      type: 'string',
      minLength: 1,
      description:
        'Default git ref the changed-file set is computed against, for a caller that passes no `--ref`. A `--ref` the caller named wins over this value, so a caller that anchors another gate on the same ref — `.husky/pre-push`, which passes `--ref origin/main` and then previews `--changed-since origin/main` — resolves ONE scope for both steps (Story #5365). Omitted and unpassed, the gate’s own default `main` applies.',
    },
  },
  additionalProperties: false,
};
