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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
