import { Schema, model } from "mongoose";

/**
 * The pro's wallet. Pro 19–24, Admin 16.
 *
 * Append-only and derived, like the customer wallet — nothing here is ever
 * updated or deleted, and a correction is a new compensating row. Two sources
 * for one balance is how a wallet screen comes to disagree with its own
 * statement.
 *
 * **`availableAt` is what makes the 48-hour rule data rather than arithmetic
 * scattered through queries.** The agreement promises auto-transfer within 48
 * hours of completion, so a credit is not withdrawable the moment it is
 * earned. Storing when it becomes available means every caller gets the same
 * answer without reimplementing the window — and `PRO-OPEN-ITEMS` 4.4 is the
 * record of what happens when two places compute the same cutoff differently:
 * one screen showed a **₹1,205 disagreement about the pro's own income.**
 */

export interface ProLedgerDoc {
  _id: string;
  proId: string;

  /**
   * `credit` is a completed job. `penalty` and `adjustment` are the admin's.
   * `payout` is money leaving the wallet.
   */
  kind: "credit" | "penalty" | "adjustment" | "payout";

  /** A booking reference for a credit, otherwise a short description. */
  label: string;

  /**
   * **Signed.** Positive for a credit, negative for anything that reduces the
   * balance — so a balance is a sum rather than a switch on `kind`, and the
   * arithmetic cannot disagree with the label.
   */
  amountPaise: number;

  /** Gross job value before the CFC fee. Credits only. */
  grossPaise?: number;
  /** CFC commission taken from the gross. Credits only. */
  feePaise?: number;
  bookingId?: string;
  bookingReference?: string;

  /**
   * When this becomes withdrawable.
   *
   * Completion + 48 hours for a credit; immediate for everything else. A
   * penalty applies at once — deferring it would let a pro withdraw money they
   * already owe back.
   */
  availableAt: Date;

  at: Date;
}

const proLedgerSchema = new Schema<ProLedgerDoc>(
  {
    _id: { type: String },
    proId: { type: String, required: true, index: true },
    kind: {
      type: String,
      required: true,
      enum: ["credit", "penalty", "adjustment", "payout"],
    },
    label: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    grossPaise: { type: Number },
    feePaise: { type: Number },
    bookingId: { type: String },
    bookingReference: { type: String },
    availableAt: { type: Date, required: true, index: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

proLedgerSchema.index({ proId: 1, at: -1 });

/** One credit per job. A retried completion must not pay twice. */
proLedgerSchema.index(
  { proId: 1, bookingId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "credit" } },
);

export const ProLedger = model<ProLedgerDoc>("ProLedger", proLedgerSchema);

/** The agreement's auto-transfer window. */
export const PAYOUT_WINDOW_HOURS = 48;

/**
 * What the pro can withdraw now, and what is still inside the window.
 *
 * The two are reported separately and **never summed into one figure**.
 * Conflating them shows a pro money they cannot take, which produces a support
 * call the moment they try.
 */
export async function proBalance(proId: string): Promise<{
  availablePaise: number;
  pendingPaise: number;
}> {
  const now = new Date();

  const [available, pending] = await Promise.all([
    ProLedger.aggregate<{ total: number }>([
      { $match: { proId, availableAt: { $lte: now } } },
      { $group: { _id: null, total: { $sum: "$amountPaise" } } },
    ]),
    ProLedger.aggregate<{ total: number }>([
      // Credits only: a pending penalty is not a thing, and a pending payout
      // would double-count money already on its way out.
      { $match: { proId, kind: "credit", availableAt: { $gt: now } } },
      { $group: { _id: null, total: { $sum: "$amountPaise" } } },
    ]),
  ]);

  return {
    availablePaise: available[0]?.total ?? 0,
    pendingPaise: pending[0]?.total ?? 0,
  };
}
