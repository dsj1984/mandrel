/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// Shell-injection constants live in config-schema-shared.js so the settings
// schema file can import them without pulling this module's AJV bundle.
// Re-exported here for backward-compatible import paths.
export { SHELL_INJECTION_RE_STRICT } from './config-schema-shared.js';

// The full agentrc schema lives in its own module to keep this file under
// escomplex's Halstead-volume ceiling. Re-exported here for import stability.
export {
  AGENTRC_SCHEMA,
  getAgentrcValidator,
} from './config-settings-schema.js';
