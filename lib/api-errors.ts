import "server-only";

import { NextResponse } from "next/server";

import {
  BadRequestError,
  MissingConfigError,
  NotConnectedError,
  errorMessage,
} from "@/lib/errors";
import type { ApiError } from "@/lib/types";

/** Maps the typed errors to HTTP so every route answers the same way. */
export function errorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof NotConnectedError) {
    return NextResponse.json(
      { error: "not_connected", message: error.message },
      { status: 401 },
    );
  }

  if (error instanceof MissingConfigError) {
    return NextResponse.json(
      { error: "missing_config", message: error.message },
      { status: 500 },
    );
  }

  if (error instanceof BadRequestError) {
    return NextResponse.json(
      { error: "bad_request", message: error.message },
      { status: 400 },
    );
  }

  console.error("Unexpected error in a Feature 1 route:", error);
  return NextResponse.json(
    { error: "internal", message: errorMessage(error) },
    { status: 500 },
  );
}
