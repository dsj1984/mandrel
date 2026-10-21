// lib/cli/doctor-checks/read-json.js — shared JSON read for the doctor checks:
// any failure degrades to `null`.

export { readJsonOrNull as readJsonSafe } from '../../../.agents/scripts/lib/json-utils.js';
