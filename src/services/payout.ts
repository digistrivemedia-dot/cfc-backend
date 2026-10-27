import { Schema, model } from "mongoose";
import { ProLedger, proBalance } from "../models/pro-ledger";
import { Pro, type ProDoc } from "../models/pro";
import { open as unseal } from "../auth/secret-box";
import { newId } from "../models/id";
import { getSettings } from "../models/settings";

/**
 * Payouts. Pro 24, Admin 18.
 *
 * The agreement: *"Daily payout option; auto-transfer to bank/UPI within 48
 * hours of completion."* So a payout is a **request against a settled
 * balance**, not an instant transfer — and the wording matters as much as the
 * mechanism.
 *
 * **"Requested", never "paid".** Claiming a completed transfer when it was only
 * initiated produces a support call the moment the pro checks their bank, and
 * costs more trust than the delay itself. Status moves to `paid` only when a
 * transfer actually settles, which needs Razorpay keys (§7.1).
 */

export interface PayoutDoc {
  _id: string;
  proId: string;
  proName: string;
  amountPaise: number;
  method: "bank" | "upi";
  /** Last four of the account, or the UPI handle. Never the full number. */
  destinationLast4: string;
  status: "pending" | "approved" | "paid" | "failed";
  requestedAt: Date;
  approvedAt?: Date;
  approvedBy?: string;
  paidAt?: Date;
  failureReason?: string;
}

const payoutSchema = new Schema<PayoutDoc>(
  {
    _id: { type: String },
    proId: { type: String, required: true, index: true },
    proName: { type: String, default: "" },
    amountPaise: { type: Number, required: true },
    method: { type: String, required: true, enum: ["bank", "upi"] },
    destinationLast4: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "approved", "paid", "failed"],
      default: "pending",
      index: true,
    },
    requestedAt: { type: Date, default: Date.now, index: true },
    approvedAt: { type: Date },
    approvedBy: { type: String },
    paidAt: { type: Date },
    failureReason: { type: String },
  },
  { versionKey: false },
);

export const Payout = model<PayoutDoc>("Payout", payoutSchema);

export type PayoutRequestResult =
  | {
      ok: true;
      payoutId: string;
      amountPaise: number;
      method: "bank" | "upi";
      destinationLast4: string;
      /** When the transfer is expected. Not when it happened. */
      expectedBy: string;
    }
  | { ok: false; reason: "below-minimum" | "nothing-available" | "already-pending" | "no-destination" };

/**
 * Pro 24 — request the payout.
 *
 * Writes a **negative ledger row** as part of the request, so the balance drops
 * immediately. Without that, a pro could request the same money twice before
 * the first transfer settled — the balance is derived from the ledger, so the
 * ledger is where the money has to leave.
 */
export async function requestPayout(
  proId: string,
  method: "bank" | "upi",
): Promise<PayoutRequestResult> {
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro?.bank) return { ok: false, reason: "no-destination" };
  if (method === "upi" && !pro.bank.upiId) {
    return { ok: false, reason: "no-destination" };
  }

  // One at a time. A second request while the first is in flight would be two
  // transfers against one balance.
  const inFlight = await Payout.findOne({
    proId,
    status: { $in: ["pending", "approved"] },
  }).lean();
  if (inFlight) return { ok: false, reason: "already-pending" };

  const { availablePaise } = await proBalance(proId);
  if (availablePaise <= 0) return { ok: false, reason: "nothing-available" };

  const settings = await getSettings();
  if (availablePaise < settings.payoutMinimumPaise) {
    return { ok: false, reason: "below-minimum" };
  }

  const destinationLast4 =
    method === "upi" ? (pro.bank.upiId ?? "") : pro.bank.accountLast4;

  const payout = await Payout.create({
    _id: newId("pay"),
    proId,
    proName: pro.name,
    amountPaise: availablePaise,
    method,
    destinationLast4,
    status: "pending",
    requestedAt: new Date(),
  });

  // The money leaves the wallet now, not when the transfer clears. Available
  // immediately, because this row is a debit rather than an earning.
  await ProLedger.create({
    _id: newId("ple"),
    proId,
    kind: "payout",
    label: `Payout requested — ${method === "upi" ? "UPI" : "bank"} ${destinationLast4}`,
    amountPaise: -availablePaise,
    availableAt: new Date(),
    at: new Date(),
  });

  return {
    ok: true,
    payoutId: payout._id,
    amountPaise: availablePaise,
    method,
    destinationLast4,
    // 24 hours is inside the agreement's 48, so this under-promises rather
    // than over-promising. It is an expectation, not a guarantee.
    expectedBy: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  };
}

/**
 * Admin 18 — approve a payout, individually or in a batch.
 *
 * Approval is where an operator commits CFC to the transfer. The transfer
 * itself needs Razorpay, so the status stops at `approved` and the pro is told
 * "approved", not "paid".
 */
export async function approvePayouts(
  payoutIds: string[],
  by: string,
): Promise<{ approved: string[]; skipped: string[] }> {
  const approved: string[] = [];
  const skipped: string[] = [];

  for (const id of payoutIds) {
    // Guarded on `pending`, so a double-click or two operators working the
    // same queue cannot approve one payout twice.
    const claimed = await Payout.findOneAndUpdate(
      { _id: id, status: "pending" },
      { $set: { status: "approved", approvedAt: new Date(), approvedBy: by } },
    ).lean();
    if (claimed) approved.push(id);
    else skipped.push(id);
  }

  return { approved, skipped };
}

/**
 * Admin 18 — reject a payout.
 *
 * **Returns the money to the wallet** with a compensating credit. The request
 * debited it, so a rejection that only changed a status would leave the pro's
 * money in neither the wallet nor a transfer.
 */
export async function rejectPayout(
  payoutId: string,
  by: string,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  const claimed = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ["pending", "approved"] } },
    {
      $set: { status: "failed", failureReason: reason, approvedBy: by },
    },
  ).lean<PayoutDoc>();

  if (!claimed) return { ok: false, reason: "That payout is no longer open." };

  await ProLedger.create({
    _id: newId("ple"),
    proId: claimed.proId,
    kind: "adjustment",
    label: `Payout returned — ${reason}`,
    amountPaise: claimed.amountPaise,
    availableAt: new Date(),
    at: new Date(),
  });

  return { ok: true };
}

/**
 * Where a payout can go. Pro 24.
 *
 * Reads the pro's own bank record and shows **last four only**. The full
 * account number is encrypted at rest and opened by nothing but an actual
 * transfer.
 */
export async function payoutDestinations(proId: string): Promise<
  { kind: "bank" | "upi"; label: string; detail: string }[]
> {
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro?.bank) return [];

  const out: { kind: "bank" | "upi"; label: string; detail: string }[] = [
    {
      kind: "bank",
      label: "Bank account",
      detail: `•••• ${pro.bank.accountLast4} · ${pro.bank.ifsc}`,
    },
  ];
  if (pro.bank.upiId) {
    out.push({ kind: "upi", label: "UPI", detail: pro.bank.upiId });
  }
  return out;
}

/**
 * The full account number, for an actual transfer.
 *
 * The **only** caller of this should be the Razorpay transfer itself. Kept here
 * rather than inline so there is one place to audit, and deliberately not
 * exposed through any route — nothing a browser can reach returns this.
 */
export async function accountNumberForTransfer(
  proId: string,
): Promise<string | null> {
  const pro = await Pro.findById(proId).select({ bank: 1 }).lean<ProDoc>();
  if (!pro?.bank) return null;
  return unseal(pro.bank.accountNumberSealed);
}
