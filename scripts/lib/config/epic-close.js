/**
 * `agentSettings.epicClose` accessor.
 *
 * Reads `epicClose.runRetro`, applying the `EPIC_CLOSE_DEFAULTS` for any field
 * the operator omitted. The legacy `sprintClose.runRetro` back-compat shim
 * shipped in 5.31.0 was removed in 5.36.4; consumers must rename the key in
 * their `.agentrc.json`.
 */

export const EPIC_CLOSE_DEFAULTS = Object.freeze({
  runRetro: true,
});

/**
 * Read the grouped `agentSettings.epicClose` block, applying framework
 * defaults for any field the operator omitted.
 *
 * @param {{ agentSettings?: { epicClose?: object } } | object | null | undefined} config
 *   Either the full resolved config or the bare `agentSettings` bag — both
 *   shapes are accepted to match the surrounding accessors.
 * @returns {{ runRetro: boolean }}
 */
export function getEpicClose(config) {
  const settings = config?.agentSettings ?? config ?? {};
  const epicClose = settings.epicClose;

  if (epicClose && epicClose.runRetro !== undefined) {
    return { runRetro: epicClose.runRetro };
  }

  return { ...EPIC_CLOSE_DEFAULTS };
}
