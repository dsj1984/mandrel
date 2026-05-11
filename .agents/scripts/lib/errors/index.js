/**
 * lib/errors/ — canonical home for custom Error subclasses used by the
 * orchestration SDK.
 *
 * Consumers import by class so tests can match on `instanceof` rather than
 * message substrings.
 */

export class ConflictingTypeLabelsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictingTypeLabelsError';
  }
}

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    Object.assign(this, details);
  }
}

/**
 * Errors raised by the `gh` CLI bridge (currently the bootstrap preflight;
 * later the `lib/gh-exec.js` shim outlined in Tech Spec #1350). Tests
 * match on `instanceof` rather than message substrings so message text
 * can evolve without churning the assertions.
 */
export class GhNotInstalledError extends Error {
  constructor(message = 'gh CLI is not installed or not on PATH') {
    super(message);
    this.name = 'GhNotInstalledError';
  }
}

export class GhAuthError extends Error {
  constructor(message = 'gh CLI is installed but not authenticated') {
    super(message);
    this.name = 'GhAuthError';
  }
}

export class GhVersionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GhVersionError';
    Object.assign(this, details);
  }
}
