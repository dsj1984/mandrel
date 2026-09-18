/** Custom Error subclasses; match on `instanceof`, not message text. */

class ConflictingTypeLabelsError extends Error {
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

/** A runtime dep (e.g. `ajv`) did not resolve; `missing` names the specifiers. */
export class MissingRuntimeDepsError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MissingRuntimeDepsError';
    Object.assign(this, details);
  }
}
