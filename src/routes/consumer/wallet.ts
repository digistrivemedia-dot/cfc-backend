import { Router } from "express";
import { badRequest, forbidden, notConfigured } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { WalletEntry, walletBalance, type WalletEntryDoc } from "../../models/wallet";

/**
 * Customer 36, 37 — the wallet and its statement.
 *
 * The balance is **derived from the ledger** on every read, never stored. See
 * the note on `models/wallet.ts` for why.
 */
export const consumerWalletRouter = Router();

consumerWalletRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

type WalletFilter = "all" | "topup" | "booking" | "refund";

const FILTER_KINDS: Record<WalletFilter, WalletEntryDoc["kind"][]> = {
  all: ["topup", "booking", "refund", "cashback", "referral"],
  topup: ["topup"],
  booking: ["booking"],
  // Refunds and the credits that behave like them, which is what a customer
  // means when they look for "money back".
  refund: ["refund", "cashback", "referral"],
};

consumerWalletRouter.get("/balance", async (req, res) => {
  res.json(await walletBalance(actorOf(req).id));
});

consumerWalletRouter.get("/transactions", async (req, res) => {
  const actor = actorOf(req);
  const filter = (req.query["filter"] as WalletFilter) ?? "all";
  const kinds = FILTER_KINDS[filter] ?? FILTER_KINDS.all;

  const rows = await WalletEntry.find({
    customerId: actor.id,
    kind: { $in: kinds },
  })
    .sort({ at: -1 })
    .lean<WalletEntryDoc[]>();

  /**
   * `balanceAfterPaise` is computed by walking the ledger forward, so a
   * statement reconciles line by line.
   *
   * Computed rather than stored: a stored running balance is wrong on every
   * earlier row the moment a backdated entry is inserted, and there is no way
   * to notice.
   */
  const ordered = [...rows].reverse();
  let running = 0;
  const withBalance = ordered.map((t) => {
    if (t.status === "completed") running += t.amountPaise;
    return {
      id: t._id,
      kind: t.kind,
      label: t.label,
      amountPaise: t.amountPaise,
      at: t.at.toISOString(),
      bookingReference: t.bookingReference,
      balanceAfterPaise: running,
      status: t.status,
    };
  });

  res.json(withBalance.reverse());
});

/**
 * Customer 36 — "add money".
 *
 * **Answers 503 rather than crediting anything.** Topping up needs a payment
 * gateway and Razorpay has no keys (§0.3). Returning `{ ok: true }` here would
 * credit real spendable balance against money that never arrived — the one
 * place a convenient stub becomes theft from the business.
 *
 * Until then the only credits are admin adjustments, refunds and referral
 * rewards, all of which originate server-side.
 */
consumerWalletRouter.post("/topup", async (req, res) => {
  const amount = (req.body as { amountPaise?: unknown })?.amountPaise;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw badRequest("Enter an amount to add.", "BAD_AMOUNT");
  }
  void res;
  throw notConfigured("Wallet top-up");
});
