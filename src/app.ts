import express, { type Express } from "express";
import cors from "cors";
import mongoose from "mongoose";
import { env } from "./env";
import { errorHandler, notFoundHandler } from "./error";
import { PUBLIC_PREFIX, PUBLIC_ROOT } from "./uploads";
import { publicRouter } from "./routes/public";
import { adminAuthRouter } from "./routes/admin/auth";
import { adminCatalogRouter } from "./routes/admin/catalog";
import { adminProsRouter } from "./routes/admin/pros";
import { adminDispatchRouter } from "./routes/admin/dispatch";
import { adminQuotationsRouter } from "./routes/admin/quotations";
import { adminPayoutsRouter } from "./routes/admin/payouts";
import { proOnboardingRouter } from "./routes/pro/onboarding";
import { proJobsRouter } from "./routes/pro/jobs";
import { proEarningsRouter } from "./routes/pro/earnings";
import { consumerAuthRouter } from "./routes/consumer/auth";
import { consumerAddressRouter } from "./routes/consumer/addresses";
import { consumerBookingRouter } from "./routes/consumer/bookings";
import { consumerWalletRouter } from "./routes/consumer/wallet";
import { consumerQuotationsRouter } from "./routes/consumer/quotations";

/**
 * The Express app, assembled.
 *
 * Separate from `index.ts` so the self-check can mount it without binding a
 * port or taking over the process.
 *
 * Route groups follow §3: one service, three groups behind one RBAC
 * middleware — `/api/public` (no auth), then `/api/consumer`, `/api/pro` and
 * `/api/admin` as the stages add them.
 */
export function createApp(): Express {
  const app = express();

  // Behind nginx on the VPS. Without this, rate limiting and request logging
  // see the proxy's address for every caller instead of the real one.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );

  // A booking draft with add-ons is a few hundred bytes. The default 100kb is
  // already generous; files go through multipart, not JSON.
  app.use(express.json({ limit: "100kb" }));

  /**
   * Health, for the load balancer and for Stage A's own exit condition.
   *
   * Reports the database separately from the process. A server that is running
   * while Mongo is unreachable is not healthy, and answering a flat "ok" there
   * is how an outage stays invisible to monitoring.
   */
  app.get("/api/health", (_req, res) => {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    const db = states[mongoose.connection.readyState] ?? "unknown";
    res.status(db === "connected" ? 200 : 503).json({
      ok: db === "connected",
      db,
      env: env.nodeEnv,
    });
  });

  /**
   * Uploaded images, served off disk.
   *
   * `PUBLIC_ROOT` only — the private root holding KYC documents is not mounted
   * here and is read back through an authenticated route instead (see
   * `uploads.ts`). `index: false` so a directory listing is never produced.
   */
  app.use(
    PUBLIC_PREFIX,
    express.static(PUBLIC_ROOT, {
      index: false,
      // Content is immutable once written: uploads get a fresh filename rather
      // than overwriting, so a long cache is safe and saves the VPS the reads.
      maxAge: "30d",
      fallthrough: true,
    }),
  );

  app.use("/api/public", publicRouter);

  /**
   * Admin. `/auth` is reachable unauthenticated by necessity — signing in is
   * how you get a token. Every other admin router mounted here goes behind
   * `requireAuth` plus a `requireSection` for the section it serves.
   */
  app.use("/api/admin/auth", adminAuthRouter);
  app.use("/api/admin/catalog", adminCatalogRouter);
  app.use("/api/admin/pros", adminProsRouter);
  app.use("/api/admin/dispatch", adminDispatchRouter);
  app.use("/api/admin/quotations", adminQuotationsRouter);
  app.use("/api/admin/payouts", adminPayoutsRouter);

  /**
   * Pro. Onboarding is partly unauthenticated by necessity — the OTP routes are
   * how a pro gets a token in the first place — so each route states its own
   * guard rather than the whole group sitting behind one.
   */
  app.use("/api/pro", proOnboardingRouter);
  app.use("/api/pro", proJobsRouter);
  app.use("/api/pro/earnings", proEarningsRouter);

  /** Customer. Only the OTP routes are reachable without a token. */
  app.use("/api/consumer/auth", consumerAuthRouter);
  app.use("/api/consumer/addresses", consumerAddressRouter);
  app.use("/api/consumer/bookings", consumerBookingRouter);
  app.use("/api/consumer/wallet", consumerWalletRouter);
  app.use("/api/consumer/quotations", consumerQuotationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
