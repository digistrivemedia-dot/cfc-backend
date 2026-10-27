import { Router } from "express";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
} from "../../middleware/auth";
import { ProLedger, proBalance, type ProLedgerDoc } from "../../models/pro-ledger";
import { Pro, type ProDoc } from "../../models/pro";
import { audit } from "../../models/audit";
import { newId } from "../../models/id";
import { param } from "../../params";
import {
  Payout,
  approvePayouts,
  rejectPayout,
  type PayoutDoc,
} from "../../services/payout";

/**
 * Admin 16, 18 — the pro wallet and the payout queue.
 *
 * Gated on `payments.approve_payout`, which the agreement gives to the Super
 * Admin alone: this is money leaving the platform.
 */
export const adminPayoutsRouter = Router();

adminPayoutsRouter.use(requireAuth, requireSection("payments"));

adminPayoutsRouter.get("/", async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : "all";
  const filter = status === "all" ? {} : { status };

  const rows = await Payout.find(filter)
    .sort({ requestedAt: 1 })
    .lean<PayoutDoc[]>();

  res.json(
    rows.map((p) => ({
      id: p._id,
      proId: p.proId,
      proName: p.proName,
      amountPaise: p.amountPaise,
      method: p.method,
      destinationLast4: p.destinationLast4,
      requestedAt: p.requestedAt.toISOString(),
      status: p.status,
      /**
       * How long the pro has been waiting, in hours.
       *
       * Surfaced because the agreement commits to 48 hours, and past that the
       * pro is owed money against a stated promise. That is the platform's
       * failure rather than a queue detail, so the number is on the row.
       */
      waitingHours: Math.round((Date.now() - p.requestedAt.getTime()) / 3_600_000),
    })),
  );
});

/**
 * Admin 18 — approve, individually or in a **batch**.
 *
 * One endpoint takes a list, because approving fourteen payouts one request at
 * a time is how an operator ends up with seven approved and seven not after a
 * dropped connection. Each is still guarded individually, so a partial batch is
 * reported rather than silently half-applied.
 */
adminPayoutsRouter.post(
  "/approve",
  requirePermission("payments.approve_payout"),
  async (req, res) => {
    const ids = (req.body as { payoutIds?: unknown })?.payoutIds;
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string") || ids.length === 0) {
      throw badRequest("Which payouts?", "MISSING_IDS");
    }

    const actor = actorOf(req);
    const result = await approvePayouts(ids as string[], actor.name);

    await audit(actor, "payout.approved", {
      detail: { approved: result.approved, skipped: result.skipped },
    });

    res.json(result);
  },
);

adminPayoutsRouter.post(
  "/:id/reject",
  requirePermission("payments.approve_payout"),
  async (req, res) => {
    const reason = (req.body as { reason?: unknown })?.reason;
    if (typeof reason !== "string" || reason.trim().length < 3) {
      // The pro reads this, and their money has just been sent back.
      throw badRequest("A reason is required.", "REASON_REQUIRED");
    }

    const actor = actorOf(req);
    const result = await rejectPayout(param(req, "id"), actor.name, reason.trim());
    if (!result.ok) throw conflict(result.reason ?? "Could not reject.", "REJECT_FAILED");

    await audit(actor, "payout.rejected", {
      subject: param(req, "id"),
      detail: { reason: reason.trim() },
    });

    res.json({ ok: true });
  },
);

/** Admin 16 — one pro's wallet, job by job. */
adminPayoutsRouter.get("/wallet/:proId", async (req, res) => {
  const proId = param(req, "proId");
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const [rows, balance] = await Promise.all([
    ProLedger.find({ proId }).sort({ at: -1 }).lean<ProLedgerDoc[]>(),
    proBalance(proId),
  ]);

  res.json({
    proId,
    proName: pro.name,
    ...balance,
    entries: rows.map((r) => ({
      id: r._id,
      proId: r.proId,
      kind: r.kind,
      label: r.label,
      amountPaise: r.amountPaise,
      at: r.at.toISOString(),
      grossPaise: r.grossPaise,
      feePaise: r.feePaise,
    })),
  });
});

/**
 * Admin 16 — a manual wallet adjustment.
 *
 * For corrections an operator has to make: a disputed penalty reversed, a
 * credit missed because of a failure elsewhere. **A new row, never an edit** —
 * the ledger is append-only, so a correction is a compensating entry and the
 * original stays visible.
 *
 * A reason is required and audited. An unexplained adjustment to someone's pay
 * is the single most questionable row in this system.
 */
adminPayoutsRouter.post(
  "/wallet/:proId/adjust",
  requirePermission("payments.approve_payout"),
  async (req, res) => {
    const proId = param(req, "proId");
    const body = (req.body ?? {}) as { amountPaise?: unknown; reason?: unknown };

    if (typeof body.amountPaise !== "number" || !Number.isInteger(body.amountPaise)) {
      throw badRequest("An amount must be a whole number of paise.", "BAD_AMOUNT");
    }
    if (body.amountPaise === 0) {
      throw badRequest("An adjustment of zero does nothing.", "BAD_AMOUNT");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length < 3) {
      throw badRequest("A reason is required.", "REASON_REQUIRED");
    }

    const pro = await Pro.findById(proId).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    const negative = body.amountPaise < 0;
    await ProLedger.create({
      _id: newId("ple"),
      proId,
      // A negative adjustment is recorded as a penalty, which is what it is
      // from the pro's side — and it keeps the two readable apart on their
      // statement.
      kind: negative ? "penalty" : "adjustment",
      label: body.reason.trim(),
      amountPaise: body.amountPaise,
      availableAt: new Date(),
      at: new Date(),
    });

    const actor = actorOf(req);
    await audit(actor, negative ? "pro.penalty.applied" : "pro.wallet.adjusted", {
      subject: proId,
      detail: { amountPaise: body.amountPaise, reason: body.reason.trim() },
    });

    res.status(201).json(await proBalance(proId));
  },
);
