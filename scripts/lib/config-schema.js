/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// Shell-injection constants live in config-schema-shared.js so the settings
// schema file can import them without pulling this module's AJV bundle.
// Re-exported here for backward-compatible import paths.
export {
  SHELL_INJECTION_PATTERN_STRING,
  SHELL_INJECTION_RE,
  SHELL_INJECTION_RE_STRICT,
} from './config-schema-shared.js';

// The full agentrc schema lives in its own module to keep this file under
// escomplex's Halstead-volume ceiling. Re-exported here for import stability.
export {
  AGENT_SETTINGS_STRING_FIELDS,
  AGENTRC_SCHEMA,
  COMMENT_EVENT_NAMES,
  getAgentrcValidator,
  WEBHOOK_EVENT_NAMES,
} from './config-settings-schema.js';
