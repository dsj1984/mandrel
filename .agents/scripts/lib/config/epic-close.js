/**
 * `agentSettings.epicClose` accessor.
 *
 * Reads the new `epicClose.runRetro` key with a one-release back-compat
 * shim that falls back to the legacy `sprintClose.runRetro` and emits a
 * one-shot `Logger.warn(...)` deprecation. The shim is registered in
 * `docs/deprecation-register.md` for removal in 5.32.0.
 */

import { Logger } from '../Logger.js';

export const EPIC_CLOSE_DEFAULTS = Object.freeze({
  runRetro: true,
});

let _legacyWarned = false;

/**
 * Read the grouped `agentSettings.epicClose` block, applying framework
 * defaults for any field the operator omitted. Falls back to the legacy
 * `sprintClose` block when `epicClose` is absent so consumer projects that
 * have not yet renamed their `.agentrc.json` keep working for one release.
 *
 * @param {{ agentSettings?: { epicClose?: object, sprintClose?: object } } | object | null | undefined} config
 *   Either the full resolved config or the bare `agentSettings` bag — both
 *   shapes are accepted to match the surrounding accessors.
 * @returns {{ runRetro: boolean }}
 */
export function getEpicClose(config) {
  const settings = config?.agentSettings ?? config ?? {};
  const epicClose = settings.epicClose;
  const sprintClose = settings.sprintClose;

  if (epicClose && epicClose.runRetro !== undefined) {
    return { runRetro: epicClose.runRetro };
  }

  if (sprintClose && sprintClose.runRetro !== undefined) {
    if (!_legacyWarned) {
      _legacyWarned = true;
      Logger.warn(
        '`agentSettings.sprintClose.runRetro` is deprecated; rename to ' +
          '`agentSettings.epicClose.runRetro`. Removal scheduled for 5.32.0.',
      );
    }
    return { runRetro: sprintClose.runRetro };
  }

  return { ...EPIC_CLOSE_DEFAULTS };
}

// Test-only: reset the one-shot warning flag so multiple unit tests can
// assert the deprecation fires without leaking state across cases.
export function _resetLegacyWarned() {
  _legacyWarned = false;
}
