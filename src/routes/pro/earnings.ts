import { Router } from "express";
import type { EarningsPeriod } from "@cfc/types";
import { EARNINGS_PERIODS } from "@cfc/types";
import { badRequest, forbidden } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { ProLedger, proBalance, type ProLedgerDoc } from "../../models/pro-ledger";
import { getSettings } from "../../models/settings";
import {
  commissionFreeRemaining,
  earningsHistory,
  earningsSeries,
  earningsSummary,
  pendingSettlements,
} from "../../services/earnings";
import {
  Payout,
  payoutDestinations,
  requestPayout,
  type PayoutDoc,
} from "../../services/payout";

/**
 * Pro 19–25 — earnings and payouts.
 *
 * Two rules run through every response here.
 *
 * **Net, never gross.** The figure on a pro's screen has to be the figure that
 * reaches their bank, or they feel short-changed every single time.
 *
 * **GST is never a pro deduction.** It applies to the platform fee charged to
 * the customer, which is a different number. `PRO-OPEN-ITEMS` puts a figure on
 * getting this wrong: ₹270 out of each pro's pocket on a ₹1,500 job.
 */
export const proEarningsRouter = Router();

proEarningsRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "pro") {
    next(forbidden());
    return;
  }
  next();
});

function period(req: { query: Record<string, unknown> }): EarningsPeriod {
  const raw = req.query["period"];
  if (typeof raw !== "string" || !EARNINGS_PERIODS.includes(raw as EarningsPeriod)) {
    throw badRequest("Period must be today, week or month.", "BAD_PERIOD");
  }
  return raw as EarningsPeriod;
}

proEarningsRouter.get("/summary", async (req, res) => {
  res.json(await earningsSummary(actorOf(req).id, period(req)));
});

proEarningsRouter.get("/series", async (req, res) => {
  res.json(await earningsSeries(actorOf(req).id, period(req)));
});

proEarningsRouter.get("/history", async (req, res) => {
  res.json(await earningsHistory(actorOf(req).id));
});

proEarningsRouter.get("/commission-free-remaining", async (req, res) => {
  res.json(await commissionFreeRemaining(actorOf(req).id));
});

/** Pro 25 — completed jobs whose money has not arrived yet. */
proEarningsRouter.get("/pending", async (req, res) => {
  res.json(await pendingSettlements(actorOf(req).id));
});

/**
 * Pro 24 — the payout balance.
 *
 * `available` and `pending` are reported **separately and never summed**.
 * Conflating them shows a pro money they cannot take, and the support call
 * arrives the moment they try.
 */
proEarningsRouter.get("/balance", async (req, res) => {
  const proId = actorOf(req).id;
  const [{ availablePaise, pendingPaise }, settings, inFlight] = await Promise.all([
    proBalance(proId),
    getSettings(),
    Payout.findOne({ proId, status: { $in: ["pending", "approved"] } }).lean(),
  ]);

  res.json({
    availablePaise,
    pendingPaise,
    // Zero means no threshold is shown, rather than one being invented. See
    // the note on the settings field.
    minimumPaise: settings.payoutMinimumPaise,
    canWithdraw:
      availablePaise > 0 &&
      availablePaise >= settings.payoutMinimumPaise &&
      inFlight === null,
    // So the screen can say "a payout is already on its way" rather than just
    // disabling the button with no explanation.
    requestInFlight: inFlight !== null,
  });
});

proEarningsRouter.get("/destinations", async (req, res) => {
  res.json(await payoutDestinations(actorOf(req).id));
});

/**
 * Pro 24 — request the payout.
 *
 * Answers **"requested"**, with an expected date. Never "paid": claiming a
 * completed transfer when it was only initiated costs more trust than the delay
 * itself.
 */
proEarningsRouter.post("/payout", async (req, res) => {
  const method = (req.body as { method?: unknown })?.method;
  if (method !== "bank" && method !== "upi") {
    throw badRequest("Choose where the payout should go.", "BAD_METHOD");
  }
  res.json(await requestPayout(actorOf(req).id, method));
});

/** The pro's own payout history. */
proEarningsRouter.get("/payouts", async (req, res) => {
  const rows = await Payout.find({ proId: actorOf(req).id })
    .sort({ requestedAt: -1 })
    .lean<PayoutDoc[]>();

  res.json(
    rows.map((p) => ({
      id: p._id,
      amountPaise: p.amountPaise,
      method: p.method,
      destinationLast4: p.destinationLast4,
      status: p.status,
      requestedAt: p.requestedAt.toISOString(),
      paidAt: p.paidAt?.toISOString() ?? null,
      failureReason: p.failureReason ?? null,
    })),
  );
});

/**
 * Admin 16's data, from the pro's own side — their wallet ledger.
 *
 * Every line, so a pro can reconcile their own statement rather than taking a
 * headline figure on trust.
 */
proEarningsRouter.get("/ledger", async (req, res) => {
  const rows = await ProLedger.find({ proId: actorOf(req).id })
    .sort({ at: -1 })
    .lean<ProLedgerDoc[]>();

  res.json(
    rows.map((r) => ({
      id: r._id,
      kind: r.kind,
      label: r.label,
      amountPaise: r.amountPaise,
      at: r.at.toISOString(),
      grossPaise: r.grossPaise,
      // A ₹0 CFC fee renders as ₹0 with its reason, never blank — a blank is
      // indistinguishable from data that failed to load.
      feePaise: r.feePaise,
      availableAt: r.availableAt.toISOString(),
      available: r.availableAt.getTime() <= Date.now(),
    })),
  );
});
