import { Schema, model } from "mongoose";

/**
 * The customer wallet — Customer 36, 37.
 *
 * **Append-only, and the balance is derived.** Never a stored counter.
 *
 * A counter and a list of lines are two sources for one number, and they drift:
 * a failed write, a retried request, or a crash between the two leaves a
 * balance that does not match its own statement. Summing the ledger cannot
 * disagree with the ledger.
 *
 * A correction is a **new compensating row**, never an edit. Nothing in this
 * codebase updates or deletes an entry here, and there is no function that
 * could — which is what makes the statement a record rather than a guess.
 *
 * `ponytail:` the balance is a `$group` sum over one customer's rows. Add a
 * periodically-snapshotted opening balance if a customer ever accumulates
 * enough lines for that scan to matter; at a few hundred rows it does not.
 */

export interface WalletEntryDoc {
  _id: string;
  customerId: string;
  kind: "topup" | "booking" | "refund" | "cashback" | "referral";
  /** What it was for — a booking reference, or a short description. */
  label: string;
  /**
   * **Signed.** A credit is positive, a debit negative, so a running balance is
   * a sum rather than a switch on `kind` — the arithmetic cannot disagree with
   * the label.
   */
  amountPaise: number;
  bookingReference?: string;
  status: "completed" | "pending" | "failed";
  at: Date;
}

const walletEntrySchema = new Schema<WalletEntryDoc>(
  {
    _id: { type: String },
    customerId: { type: String, required: true, index: true },
    kind: {
      type: String,
      required: true,
      enum: ["topup", "booking", "refund", "cashback", "referral"],
    },
    label: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    bookingReference: { type: String },
    status: {
      type: String,
      required: true,
      enum: ["completed", "pending", "failed"],
      default: "completed",
    },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

walletEntrySchema.index({ customerId: 1, at: -1 });

export const WalletEntry = model<WalletEntryDoc>(
  "WalletEntry",
  walletEntrySchema,
);

/**
 * The balance: the sum of every **completed** line.
 *
 * Pending and failed lines are excluded. A pending top-up is money that has not
 * arrived, and showing it as spendable is how a wallet goes negative.
 */
export async function walletBalance(customerId: string): Promise<number> {
  const [row] = await WalletEntry.aggregate<{ total: number }>([
    { $match: { customerId, status: "completed" } },
    { $group: { _id: null, total: { $sum: "$amountPaise" } } },
  ]);
  return row?.total ?? 0;
}
