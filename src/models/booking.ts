import { Schema, model } from "mongoose";
import type { BookingStatus, PriceBreakdown } from "@cfc/types";
import { BOOKING_STATUSES } from "@cfc/types";
import type { AddressSub } from "./customer";

/**
 * A booking. Customer 18–30, Pro 12–19, Admin 6–8.
 *
 * Three decisions here matter more than the rest.
 *
 * **The price breakdown is frozen at booking time.** §4.1 of the plan: without
 * this, the invoice recomputes from *current* admin-editable pricing, so editing
 * a platform fee silently rewrites every historical tax invoice. These are tax
 * documents. `CONSUMER-OPEN-ITEMS.md` 2.18 flagged it for exactly this reason,
 * and `bookings/[id]/invoice/page.tsx:246` makes it worse today by computing the
 * split for a hardcoded `svc_01` — so the tax invoice is wrong for every other
 * service right now.
 *
 * **The address is a copy, not a reference.** A customer who edits or deletes
 * an address must not change where last month's job happened, and the pro's
 * record of where they went has to stay true.
 *
 * **The service name is copied too**, for the same reason: renaming a service
 * must not rewrite the history of what people bought.
 */

const breakdownSchema = new Schema<PriceBreakdown>(
  {
    servicePaise: { type: Number, required: true },
    addOnsPaise: { type: Number, required: true },
    visitChargePaise: { type: Number, required: true },
    platformFeePaise: { type: Number, required: true },
    discountPaise: { type: Number, required: true },
    cgstPaise: { type: Number, required: true },
    sgstPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

export interface BookingEventSub {
  at: Date;
  label: string;
  /** Who caused it — the customer, the pro, an admin, or the system. */
  actor: string;
  /** Set when an admin forced this state rather than it occurring naturally. */
  forced?: boolean;
}

const eventSchema = new Schema<BookingEventSub>(
  {
    at: { type: Date, required: true },
    label: { type: String, required: true },
    actor: { type: String, required: true },
    forced: { type: Boolean },
  },
  { _id: false },
);

export interface BookingDoc {
  _id: string;
  /** What a customer quotes on the phone, e.g. CFC12345678. Unique. */
  reference: string;

  customerId: string;
  /** Copied, so renaming an account does not rewrite history. */
  customerName: string;
  customerPhone: string;

  serviceId: string;
  /** Copied — see the note above. */
  serviceName: string;
  variantId: string | null;
  /**
   * The variant's name at booking time.
   *
   * §4.5: the cart dropped the chosen variant entirely, so picking "2 ton
   * window" and booking got you the base price. Carried here so the booking
   * records what was actually chosen.
   */
  variantName: string | null;
  addOnIds: string[];
  quantity: number;

  scheduledAt: Date;
  /** Arrival window length, from the variant plus any add-ons. */
  durationMinutes: number;

  /** A frozen copy. See the note above. */
  address: AddressSub;

  /** Frozen at booking time. The invoice reads this, never live pricing. */
  breakdown: PriceBreakdown;
  couponCode: string | null;

  status: BookingStatus;
  events: BookingEventSub[];

  paymentMethod: "upi" | "card" | "cash" | "wallet";
  paid: boolean;

  /** Null until dispatch assigns one. Phase 6. */
  proId: string | null;
  /**
   * The code the customer shows the pro to close the job.
   *
   * Generated at assignment and revealed to the customer only once a pro is on
   * the way — a code visible for days is a code that leaks.
   */
  completionOtp: string | null;

  beforePhotoPaths: string[];
  afterPhotoPaths: string[];

  rated: boolean;
  /** What the customer typed when booking. */
  notes: string | null;

  /**
   * Charges added on site. Pro 15.
   *
   * Deliberately **not** a quotation. A quotation is a priced proposal an admin
   * reviews and the customer accepts with a 50% advance; these are small,
   * explainable additions to work already under way — a part, a second visit
   * charge. Conflating them is how a pro routes ₹4,000 of work around the
   * approval flow.
   */
  extraCharges: { id: string; label: string; amountPaise: number; at: Date }[];

  /**
   * Where the pro was when they closed the job, and how far that was.
   *
   * `completionDistanceM` is null when the device could get no fix — which does
   * **not** block completion. Recorded either way, because it is the proof, and
   * a null is exactly the case an admin may want to review.
   */
  completionDistanceM?: number | null;
  completedAt?: Date;

  /** What the pro earned, frozen at completion like the customer's breakdown. */
  settlement?: {
    grossPaise: number;
    cfcFeePaise: number;
    netPaise: number;
    commissionFree: boolean;
    at: Date;
  };

  /**
   * The client's idempotency key.
   *
   * A double-tap on a slow connection must not create two bookings, and a
   * customer who was charged twice for one job is the worst bug this flow can
   * have. Unique and sparse, so the uniqueness is enforced by the database
   * rather than by a check that can race.
   */
  idempotencyKey?: string;

  createdAt: Date;
  updatedAt: Date;
}

const bookingSchema = new Schema<BookingDoc>(
  {
    _id: { type: String },
    reference: { type: String, required: true, unique: true },

    customerId: { type: String, required: true, index: true },
    /**
     * Not required, and that is the point.
     *
     * A customer signs in with an OTP and can book immediately — there is no
     * registration form, by design, because the 3-click target cannot afford
     * one. So their name is often `""` on a first booking. Mongoose treats an
     * empty string as missing for a `required` String, which made this field
     * reject **every booking by a customer who had not set a name** — the
     * common case for a first-time user.
     *
     * Stored as given; the admin list falls back to the phone when it is blank.
     */
    customerName: { type: String, default: "" },
    customerPhone: { type: String, required: true },

    serviceId: { type: String, required: true, index: true },
    serviceName: { type: String, required: true },
    variantId: { type: String, default: null },
    variantName: { type: String, default: null },
    addOnIds: { type: [String], default: [] },
    quantity: { type: Number, default: 1 },

    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 120 },

    address: { type: Schema.Types.Mixed, required: true },

    breakdown: { type: breakdownSchema, required: true },
    couponCode: { type: String, default: null },

    status: {
      type: String,
      required: true,
      enum: BOOKING_STATUSES,
      default: "pending",
      index: true,
    },
    events: { type: [eventSchema], default: [] },

    paymentMethod: {
      type: String,
      required: true,
      enum: ["upi", "card", "cash", "wallet"],
    },
    paid: { type: Boolean, default: false },

    proId: { type: String, default: null, index: true },
    completionOtp: { type: String, default: null },

    beforePhotoPaths: { type: [String], default: [] },
    afterPhotoPaths: { type: [String], default: [] },

    rated: { type: Boolean, default: false },
    notes: { type: String, default: null },

    extraCharges: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            label: { type: String, required: true },
            amountPaise: { type: Number, required: true },
            at: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    completionDistanceM: { type: Number, default: null },
    completedAt: { type: Date },
    settlement: {
      type: new Schema(
        {
          grossPaise: { type: Number, required: true },
          cfcFeePaise: { type: Number, required: true },
          netPaise: { type: Number, required: true },
          commissionFree: { type: Boolean, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: false,
    },

    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true, versionKey: false },
);

/** The customer's own list, newest first. */
bookingSchema.index({ customerId: 1, scheduledAt: -1 });

export const Booking = model<BookingDoc>("Booking", bookingSchema);

/**
 * The state machine. **One table, shared by every caller.**
 *
 * A booking and a job are the same thing seen from two sides, and two machines
 * would eventually disagree about whether a given move is legal. Every
 * transition in the system goes through `canTransition`.
 */
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled", "pending"],
  in_progress: ["completed", "cancelled"],
  // Terminal. A completed job is not re-opened; a correction is an adjustment
  // on the ledger, not a rewrite of what happened.
  completed: [],
  cancelled: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * A customer-facing reference.
 *
 * `CFC` plus eight digits, matching what every screen already displays. Random
 * rather than sequential: a sequential reference tells anyone holding one how
 * many bookings the platform has taken, and invites trying the next.
 */
export function newReference(): string {
  const n = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `CFC${n}`;
}

/** The completion OTP a customer shows the pro. Six digits, like every other. */
export function newCompletionOtp(): string {
  return String(Math.floor(100_000 + Math.random() * 899_999));
}
