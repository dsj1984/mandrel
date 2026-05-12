/**
 * lib/spec/index.js — public surface for the spec I/O module.
 *
 * Re-exports the loader (and, in Wave 1, future spec utilities) so
 * downstream consumers — the reconciler, the rewritten /epic-plan, the
 * wave-runner — can `import * from '../lib/spec/index.js'` without
 * reaching into individual submodules.
 *
 * The module intentionally re-exports only the public surface defined
 * by Story #1491; the loader's internal helpers (`_resetValidatorCacheForTests`,
 * `sortKeysDeep`, `renderStateJson`) remain importable from
 * `./loader.js` directly for tests but are not part of the consumer
 * contract.
 */

export {
  loadSpec,
  loadState,
  SpecNotFoundError,
  SpecParseError,
  SpecValidationError,
  specPath,
  statePath,
  writeState,
} from './loader.js';
