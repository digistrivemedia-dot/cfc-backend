import type { Request, RequestHandler } from "express";
import { ApiError } from "../error";
import { env } from "../env";

/**
 * A fixed-window rate limiter, in process memory.
 *
 * Login and OTP endpoints need one before they exist, not after: an unlimited
 * login endpoint is a password-guessing service, and an unlimited OTP endpoint
 * is a way to spend the client's SMS budget.
 *
 * `ponytail:` in-memory, single process. Counters reset on restart and are not
 * shared between instances, so running two of these behind a load balancer
 * doubles every limit. The fix is a shared store (Mongo or Redis) and §3 says
 * add Redis only when the load test names it — so until this server is
 * replicated, memory is the honest answer. **Revisit before scaling out.**
 */

interface Window {
  count: number;
  /** When the current window ends, in epoch ms. */
  resetAt: number;
}

const buckets = new Map<string, Window>();

// Stale windows would otherwise accumulate one entry per attacker IP forever.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
  // `unref` so this timer never keeps the process alive during a shutdown.
}, SWEEP_INTERVAL_MS).unref();

export interface RateLimitOptions {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Attempts allowed per window. */
  max: number;
  /**
   * What counts as one caller. Defaults to the IP.
   *
   * Login passes a key combining IP **and** email: limiting by IP alone lets
   * one attacker lock out a whole office behind a shared address, and limiting
   * by email alone lets a botnet spread its guesses across addresses.
   */
  keyOf?: (req: Request) => string;
  /** Shown to the caller. Says what to do, not how the limiter works. */
  message?: string;
  /**
   * Lifted while `AUTH_DUMMY_OTP` is on.
   *
   * For the OTP endpoints only. The limit exists to protect an SMS budget and
   * to stop code-guessing — and with the dummy on there is no SMS to spend
   * and no code to guess, so all it does is lock a developer out of the app
   * after five attempts with no way back in but waiting fifteen minutes.
   *
   * The limiter itself is untouched and returns the moment the dummy goes
   * off, which is the moment there is a budget to protect.
   */
  relaxedWhenDummyOtp?: boolean;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const {
    windowSeconds,
    max,
    keyOf = (req) => req.ip ?? "unknown",
    message = "Too many attempts. Please wait a moment and try again.",
    relaxedWhenDummyOtp = false,
  } = options;

  return (req, res, next) => {
    if (relaxedWhenDummyOtp && env.dummyOtp) {
      next();
      return;
    }

    const key = `${req.method} ${req.route?.path ?? req.path}:${keyOf(req)}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      next(new ApiError(429, message, "RATE_LIMITED"));
      return;
    }

    next();
  };
}

/** Test seam: the self-check needs a clean slate between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
