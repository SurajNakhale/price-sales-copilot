/**
 * The small set of typed errors the route handlers map to HTTP responses.
 * Anything else becomes a 500.
 */

/** No usable Google tokens: never connected, disconnected, or the grant was revoked. */
export class NotConnectedError extends Error {
  readonly code = "not_connected" as const;

  constructor(message = "Not connected to Gmail. Connect Gmail and try again.") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** A required environment variable is missing or empty. */
export class MissingConfigError extends Error {
  readonly code = "missing_config" as const;

  constructor(message: string) {
    super(message);
    this.name = "MissingConfigError";
  }
}

/** The request body was not the shape the route expects. */
export class BadRequestError extends Error {
  readonly code = "bad_request" as const;

  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** The thing the request names does not exist: an unknown file ID, or no review yet. */
export class NotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The request is valid but the current state forbids it: already approved, or out of date. */
export class ConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A supplier file that cannot be analysed as it is: empty, too big, or for an unknown brand. */
export class UnusableFileError extends Error {
  readonly code = "unusable_file" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnusableFileError";
  }
}

/** The LLM answered twice with something that failed validation. Never accepted silently. */
export class InvalidLlmOutputError extends Error {
  readonly code = "invalid_llm_output" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidLlmOutputError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
