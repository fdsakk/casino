// Error handling: Result pattern and domain errors
// Provides a consistent error model used across the app:
// - AppError: typed domain errors with HTTP status codes
// - Result<T>: success/failure union without throwing exceptions
// - mapResultToResponse: helper to convert Result to Hono JSON responses

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Error codes — list of domain error identifiers

export const ErrorCode = {
  // Auth / access
  NOT_AUTHENTICATED: "not_authenticated",
  FORBIDDEN: "forbidden",

  // Balance
  INSUFFICIENT_FUNDS: "insufficient_funds",

  // Roulette
  NO_ACTIVE_SEED: "no_active_seed",
  SEED_NOT_FOUND: "seed_not_found",
  SEED_STILL_ACTIVE: "seed_still_active",
  MISSING_SEED_ID: "missing_seed_id",
  INVALID_NONCE: "invalid_nonce",

  // Blackjack
  ACTIVE_GAME_EXISTS: "active_game_exists",
  NO_ACTIVE_GAME: "no_active_game",
  INSURANCE_NOT_AVAILABLE: "insurance_not_available",
  INSURANCE_PENDING: "insurance_pending",
  NOT_YOUR_TURN: "not_your_turn",
  NO_ACTIVE_HAND: "no_active_hand",
  SPLIT_ACES_NO_ACTIONS: "split_aces_no_actions",
  CANNOT_DOUBLE_NOW: "cannot_double_now",
  CANNOT_SPLIT: "cannot_split",

  // Expenses
  EXPENSE_CREATE_FAILED: "expense_create_failed",

  // Generic
  INTERNAL_ERROR: "internal_error",
  VALIDATION_ERROR: "validation_error",
  NOT_FOUND: "not_found",
  DUPLICATE: "duplicate",
  RATE_LIMITED: "rate_limited",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// Error → HTTP status mapping

const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.NOT_AUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INSUFFICIENT_FUNDS]: 402,
  [ErrorCode.NO_ACTIVE_SEED]: 500,
  [ErrorCode.SEED_NOT_FOUND]: 404,
  [ErrorCode.SEED_STILL_ACTIVE]: 400,
  [ErrorCode.MISSING_SEED_ID]: 400,
  [ErrorCode.INVALID_NONCE]: 400,
  [ErrorCode.ACTIVE_GAME_EXISTS]: 409,
  [ErrorCode.NO_ACTIVE_GAME]: 404,
  [ErrorCode.INSURANCE_NOT_AVAILABLE]: 400,
  [ErrorCode.INSURANCE_PENDING]: 400,
  [ErrorCode.NOT_YOUR_TURN]: 400,
  [ErrorCode.NO_ACTIVE_HAND]: 400,
  [ErrorCode.SPLIT_ACES_NO_ACTIONS]: 400,
  [ErrorCode.CANNOT_DOUBLE_NOW]: 400,
  [ErrorCode.CANNOT_SPLIT]: 400,
  [ErrorCode.EXPENSE_CREATE_FAILED]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
};

// AppError — typed domain error class

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }

  get statusCode(): number {
    return ERROR_STATUS_MAP[this.code] ?? 500;
  }

  toJSON() {
    const isProduction = process.env.NODE_ENV === "production";
    const safeMessage =
      !isProduction && this.message !== this.code
        ? { message: this.message }
        : {};

    return {
      error: this.code,
      ...safeMessage,
      ...(!isProduction && this.details ? { details: this.details } : {}),
    };
  }
}

// Result<T> — discriminated union for success/failure

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

// Create a success result
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

// Create a failure result
export function err<T = never>(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): Result<T> {
  return { ok: false, error: new AppError(code, message, details) };
}

// Hono response helpers

// Map a Result<T> to a Hono JSON response.
// Success -> 200 with data. Failure -> error payload with correct status.
export function mapResultToResponse<T>(c: Context, result: Result<T>) {
  if (result.ok) {
    return c.json(result.data);
  }
  return c.json(result.error.toJSON(), result.error.statusCode as ContentfulStatusCode);
}

// Map a Result<T> to a Hono JSON response with a custom success status.
export function mapResultToResponseWithStatus<T>(
  c: Context,
  result: Result<T>,
  successStatus: ContentfulStatusCode,
) {
  if (result.ok) {
    return c.json(result.data, successStatus);
  }
  return c.json(result.error.toJSON(), result.error.statusCode as ContentfulStatusCode);
}
