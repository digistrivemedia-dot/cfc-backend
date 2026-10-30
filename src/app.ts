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
import { adminCustomersRouter } from "./routes/admin/customers";
import { adminBookingsRouter } from "./routes/admin/bookings";
import { adminDispatchRouter } from "./routes/admin/dispatch";
import { adminQuotationsRouter } from "./routes/admin/quotations";
import { adminPayoutsRouter } from "./routes/admin/payouts";
import { adminDashboardRouter, adminFinanceRouter } from "./routes/admin/finance";
import { adminReportsRouter } from "./routes/admin/reports";
import {
  adminPromotionsRouter,
  adminUsersRouter,
} from "./routes/admin/promotions";
import { adminSettingsRouter } from "./routes/admin/settings";
import { adminFaqRouter } from "./routes/admin/faqs";
import {
  adminTicketRouter,
  consumerTicketRouter,
  proTicketRouter,
} from "./routes/tickets";
import { proOnboardingRouter } from "./routes/pro/onboarding";
import { proJobsRouter } from "./routes/pro/jobs";
import { proEarningsRouter } from "./routes/pro/earnings";
import { proReviewRouter } from "./routes/pro/reviews";
import { proProfileRouter } from "./routes/pro/profile";
import { consumerAuthRouter } from "./routes/consumer/auth";
import { consumerAddressRouter } from "./routes/consumer/addresses";
import { consumerBookingRouter } from "./routes/consumer/bookings";
import { consumerWalletRouter } from "./routes/consumer/wallet";
import { consumerQuotationsRouter } from "./routes/consumer/quotations";
import { consumerReviewRouter } from "./routes/consumer/reviews";
import {
  consumerNotificationRouter,
  proNotificationRouter,
} from "./routes/notifications";

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
  app.use("/api/admin/customers", adminCustomersRouter);
  app.use("/api/admin/bookings", adminBookingsRouter);
  app.use("/api/admin/dispatch", adminDispatchRouter);
  app.use("/api/admin/quotations", adminQuotationsRouter);
  app.use("/api/admin/payouts", adminPayoutsRouter);
  app.use("/api/admin/dashboard", adminDashboardRouter);
  app.use("/api/admin/finance", adminFinanceRouter);
  app.use("/api/admin/reports", adminReportsRouter);
  app.use("/api/admin/promotions", adminPromotionsRouter);
  app.use("/api/admin/users", adminUsersRouter);
  app.use("/api/admin/settings", adminSettingsRouter);
  app.use("/api/admin/faqs", adminFaqRouter);

  app.use("/api/admin/tickets", adminTicketRouter);

  /**
   * Pro. Onboarding is partly unauthenticated by necessity — the OTP routes are
   * how a pro gets a token in the first place — so each route states its own
   * guard rather than the whole group sitting behind one.
   */
  app.use("/api/pro", proOnboardingRouter);
  app.use("/api/pro", proJobsRouter);
  app.use("/api/pro/earnings", proEarningsRouter);
  app.use("/api/pro/notifications", proNotificationRouter);
  app.use("/api/pro/tickets", proTicketRouter);
  app.use("/api/pro/reviews", proReviewRouter);
  app.use("/api/pro/profile", proProfileRouter);

  /** Customer. Only the OTP routes are reachable without a token. */
  app.use("/api/consumer/auth", consumerAuthRouter);
  app.use("/api/consumer/addresses", consumerAddressRouter);
  app.use("/api/consumer/bookings", consumerBookingRouter);
  app.use("/api/consumer/wallet", consumerWalletRouter);
  app.use("/api/consumer/quotations", consumerQuotationsRouter);
  app.use("/api/consumer/reviews", consumerReviewRouter);
  app.use("/api/consumer/notifications", consumerNotificationRouter);
  app.use("/api/consumer/tickets", consumerTicketRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
