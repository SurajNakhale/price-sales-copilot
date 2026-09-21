import "server-only";

import { NextResponse } from "next/server";

import {
  BadRequestError,
  ConflictError,
  InvalidLlmOutputError,
  MissingConfigError,
  NotConnectedError,
  NotFoundError,
  UnusableFileError,
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

  if (error instanceof NotFoundError) {
    return NextResponse.json(
      { error: "not_found", message: error.message },
      { status: 404 },
    );
  }

  if (error instanceof ConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { status: 409 },
    );
  }

  if (error instanceof UnusableFileError) {
    return NextResponse.json(
      { error: "unusable_file", message: error.message },
      { status: 422 },
    );
  }

  if (error instanceof InvalidLlmOutputError) {
    return NextResponse.json(
      { error: "invalid_llm_output", message: error.message },
      { status: 502 },
    );
  }

  console.error("Unexpected error in an API route:", error);
  return NextResponse.json(
    { error: "internal", message: errorMessage(error) },
    { status: 500 },
  );
}
