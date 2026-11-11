import { Schema, model } from "mongoose";
import type { QuotationStatus } from "@cfc/types";
import { QUOTATION_STATUSES } from "@cfc/types";

/**
 * A quotation. Pro 16, Admin 4–5, Customer 22–24.
 *
 * *"The panel's priority path."* A pro on site assesses a job that turns out to
 * be bigger than the booking, prices it, and the admin has **15 minutes** to
 * decide — because that is how long the pro is standing in someone's house.
 *
 * The decision this schema exists to support: **an edit keeps both figures.**
 * When an admin approves at a different amount than the pro submitted, the
 * original stays on the record. An approved amount differing from the submitted
 * one, with no history of either, is a dispute nobody can settle — the pro says
 * they quoted ₹4,000, the customer was charged ₹4,800, and there is nothing to
 * check.
 */

export interface MaterialLineSub {
  description: string;
  costPaise: number;
}

const materialSchema = new Schema<MaterialLineSub>(
  {
    description: { type: String, required: true, trim: true },
    costPaise: { type: Number, required: true },
  },
  { _id: false },
);

export interface QuotationDoc {
  _id: string;

  bookingId: string;
  /** Copied, so the quote reads correctly even if a reference is reused. */
  jobRef: string;
  proId: string;
  proName: string;
  customerId: string;
  customerName: string;
  serviceName: string;

  /** What the pro found, in their own words. The customer reads this. */
  proNotes: string;

  // -- what the pro submitted. Never overwritten by an edit. ----------------
  submittedMaterials: MaterialLineSub[];
  submittedLabourPaise: number;
  submittedTotalPaise: number;

  // -- what the admin approved. Equal to the above unless edited. -----------
  materials: MaterialLineSub[];
  labourPaise: number;
  totalPaise: number;
  /**
   * True when an admin changed the figures before approving.
   *
   * Carried explicitly rather than inferred by comparing totals: an edit that
   * moved a line between materials and labour without changing the total is
   * still an edit, and the pro should see that it happened.
   */
  edited: boolean;

  /**
   * Proof the work is needed. **Minimum two**, enforced on submission.
   *
   * Paths under the public upload root — the customer sees these when deciding,
   * and they are photographs of a fault rather than identity documents.
   */
  beforePhotoPaths: string[];

  status: QuotationStatus;

  /**
   * When the admin's 15 minutes expire.
   *
   * A sweep marks the lapse. Trusting the UI to notice would leave a quote
   * sitting "pending" forever once the operator closed the tab.
   */
  decisionBy: Date;
  decidedAt?: Date;
  decidedBy?: string;
  rejectionReason?: string;

  /**
   * Above ₹5,000 the admin phones the customer before approving.
   *
   * **A flag, not a block.** The agreement makes it something the admin acts
   * on, not a gate the system enforces — so it is surfaced on the queue and
   * the decision stays theirs.
   */
  needsPhoneConfirmation: boolean;

  /**
   * The admin's template price for this service, at submission time.
   *
   * Admin 5 and 28: *"quotes exceeding the template trigger review"*. Frozen
   * here so the comparison an operator saw is the one recorded, even if the
   * catalogue price changes afterwards.
   */
  templatePricePaise: number;

  // -- the customer's decision ----------------------------------------------
  /**
   * @deprecated The 50% advance is gone. **The customer pays in full on
   * completion**, so accepting a quotation moves no money.
   *
   * Kept on the schema, and only on the schema: quotations taken under the old
   * flow carry a real advance that was really collected, and zeroing those
   * rows would rewrite what somebody actually paid. Nothing writes these any
   * more and no projection sends them.
   */
  advancePaise: number;
  /** @deprecated See `advancePaise`. */
  balancePaise: number;
  /** @deprecated See `advancePaise`. */
  advancePaid: boolean;
  acceptedAt?: Date;
  declinedAt?: Date;

  /**
   * The code the customer reads out to start the **quoted** work.
   *
   * Generated when the customer confirms, and separate from the booking's own
   * `startOtp` deliberately: that one proves the customer let the pro in to do
   * the work they booked. This one proves they agreed, in person and at the
   * door, to a different and usually much larger piece of work — on your own
   * data, a ₹350 booking turning into ₹3,700.
   *
   * **Never sent to the professional.** The server compares it. A code the pro
   * can read out of a response proves nothing at all.
   *
   * Cleared once used, so a screenshot taken during the visit is worth nothing
   * afterwards.
   */
  startOtp: string | null;

  /**
   * When the pro entered that code.
   *
   * Carried instead of a new `QuotationStatus` member: "accepted" and "work
   * under way" are the same agreement at two moments, and a sixth status would
   * have to be taught to every badge, filter and label in three apps to say
   * something a timestamp says exactly.
   *
   * **It gates completion.** `completeJob` refuses to close a job with an
   * accepted quotation that never started, because the money for that work is
   * now in the pro's settlement and the customer's in-person confirmation is
   * the only thing standing behind it.
   */
  workStartedAt?: Date;

  /**
   * Questions the customer asked. Customer 23.
   *
   * Recorded, not threaded: there is no message thread on a quotation in the
   * data model and inventing one would imply a reply the platform cannot
   * deliver. The screen says support will call, and this is what they call
   * about. Routed to the **team, not the pro** (`CONSUMER-OPEN-ITEMS` 2.15).
   */
  questions: { body: string; at: Date; answeredAt?: Date }[];

  createdAt: Date;
  updatedAt: Date;
}

const quotationSchema = new Schema<QuotationDoc>(
  {
    _id: { type: String },

    bookingId: { type: String, required: true, index: true },
    jobRef: { type: String, required: true },
    proId: { type: String, required: true, index: true },
    proName: { type: String, default: "" },
    customerId: { type: String, required: true, index: true },
    customerName: { type: String, default: "" },
    serviceName: { type: String, required: true },

    proNotes: { type: String, required: true, trim: true },

    submittedMaterials: { type: [materialSchema], default: [] },
    submittedLabourPaise: { type: Number, required: true },
    submittedTotalPaise: { type: Number, required: true },

    materials: { type: [materialSchema], default: [] },
    labourPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    edited: { type: Boolean, default: false },

    beforePhotoPaths: { type: [String], default: [] },

    status: {
      type: String,
      required: true,
      enum: QUOTATION_STATUSES,
      default: "pending",
      index: true,
    },

    decisionBy: { type: Date, required: true, index: true },
    decidedAt: { type: Date },
    decidedBy: { type: String },
    rejectionReason: { type: String, trim: true },

    needsPhoneConfirmation: { type: Boolean, default: false },
    templatePricePaise: { type: Number, default: 0 },

    advancePaise: { type: Number, default: 0 },
    balancePaise: { type: Number, default: 0 },
    advancePaid: { type: Boolean, default: false },
    acceptedAt: { type: Date },
    declinedAt: { type: Date },

    startOtp: { type: String, default: null },
    workStartedAt: { type: Date },

    questions: {
      type: [
        new Schema(
          {
            body: { type: String, required: true },
            at: { type: Date, default: Date.now },
            answeredAt: { type: Date },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

/** The admin queue: pending first, soonest deadline at the top. */
quotationSchema.index({ status: 1, decisionBy: 1 });

export const Quotation = model<QuotationDoc>("Quotation", quotationSchema);

/** The quote's total. One function, so the form and the record agree. */
export function quoteTotal(
  materials: MaterialLineSub[],
  labourPaise: number,
): number {
  return materials.reduce((t, m) => t + m.costPaise, 0) + labourPaise;
}

/**
 * @deprecated **There is no advance.** The customer pays the full quotation
 * when the job is finished, with the booking.
 *
 * Kept only because `@cfc/mocks` re-exports it for the fixture path, which has
 * no server to read a figure from. Delete it with the fixtures.
 */
export function splitQuotation(totalPaise: number): {
  advancePaise: number;
  balancePaise: number;
} {
  const advancePaise = Math.round(totalPaise / 200) * 100;
  return { advancePaise, balancePaise: totalPaise - advancePaise };
}
