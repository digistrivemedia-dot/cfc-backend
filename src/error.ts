import type { NextFunction, Request, Response } from "express";
import { ApiError } from "@cfc/types";
import { env } from "./env";

/**
 * The error envelope: `{ status, message, code }`.
 *
 * `ApiError` is imported from `@cfc/types` rather than redefined here — it is
 * the same class the browser throws, so the shape cannot drift between the two
 * sides. Every error screen in all three apps already renders from it, which
 * means matching it makes those screens work with no further effort.
 *
 * Throw it from anywhere. Express 5 forwards a rejected async handler to this
 * middleware on its own, so there is no `asyncHandler` wrapper in this codebase
 * and route handlers can be plain `async` functions.
 */
export { ApiError };

/** 400 — the request itself is wrong. */
export const badRequest = (message: string, code?: string) =>
  new ApiError(400, message, code);

/** 401 — no usable credentials. */
export const unauthorized = (message = "Please sign in again.") =>
  new ApiError(401, message, "UNAUTHORIZED");

/** 403 — authenticated, but not allowed. Never explains what was missing. */
export const forbidden = (message = "You do not have access to that.") =>
  new ApiError(403, message, "FORBIDDEN");

/** 404 — and the message is what a customer or operator will read. */
export const notFound = (message = "Not found.") =>
  new ApiError(404, message, "NOT_FOUND");

/** 409 — the request conflicts with current state. */
export const conflict = (message: string, code?: string) =>
  new ApiError(409, message, code);

/**
 * A deferred integration, asked for before its credentials exist.
 *
 * 503 rather than 500: nothing is broken, the feature is not configured yet.
 * Razorpay and MSG91 both answer with this until keys arrive, so a caller gets
 * a truthful "not available" instead of a fake success.
 */
export const notConfigured = (what: string) =>
  new ApiError(
    503,
    `${what} is not configured yet.`,
    "NOT_CONFIGURED",
  );

/**
 * The terminal error handler. Mounted last.
 *
 * An `ApiError` is deliberate and its message is meant to be read, so it goes
 * out as written. Anything else is a bug: it is logged in full and answered
 * with a generic 500, because an unplanned error's message is as likely to
 * contain a stack frame or a connection string as anything useful.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Past headers, the response is already on the wire; let Express tear it down.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      status: err.status,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  res.status(500).json({
    status: 500,
    message: "Something went wrong at our end.",
    code: "INTERNAL",
    // Only ever in development, and only the message — never the stack.
    ...(env.isProduction
      ? {}
      : { detail: err instanceof Error ? err.message : String(err) }),
  });
}

/** Mounted after every route: an unmatched path is a 404 in the same envelope. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, `No such endpoint: ${req.method} ${req.path}`, "NO_ROUTE"));
}
