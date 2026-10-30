import { Schema, model } from "mongoose";

/**
 * Admin 17 — the discipline record.
 *
 * **Append-only, like the ledger it can write to.** A warning is never edited
 * or deleted: the screen counts warnings per pro to decide escalation, and a
 * record that can be quietly tidied away cannot support "this is your third".
 * A warning issued in error is answered by a compensating wallet adjustment
 * and a note, not by making the row disappear.
 *
 * `penaltyPaise` is stored **positive** here — it reads as "the size of the
 * fine" on an admin screen — while the ledger row it creates is negative,
 * because a balance there is a sum. The two are written in one request so they
 * cannot drift apart.
 */

export interface ProWarningDoc {
  _id: string;
  proId: string;
  /** Denormalised so the cross-pro list needs no join to render a name. */
  proName: string;
  reason: string;
  /** Positive. Zero means a warning with no deduction, which is allowed. */
  penaltyPaise: number;
  /** The ledger row this warning created, absent when there was no penalty. */
  ledgerId?: string;
  issuedBy: string;
  issuedAt: Date;
}

const proWarningSchema = new Schema<ProWarningDoc>(
  {
    _id: { type: String },
    proId: { type: String, required: true, index: true },
    proName: { type: String, required: true },
    reason: { type: String, required: true },
    penaltyPaise: { type: Number, required: true, default: 0 },
    ledgerId: { type: String },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

/** The list is always newest-first, per pro or across all of them. */
proWarningSchema.index({ proId: 1, issuedAt: -1 });

export const ProWarning = model<ProWarningDoc>("ProWarning", proWarningSchema);
