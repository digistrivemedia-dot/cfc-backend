import { Schema, model } from "mongoose";

/**
 * A job offer to one pro. Pro 12, Admin 9/10.
 *
 * One row per (booking, pro) pair, because the agreement notifies **three pros
 * simultaneously** and first-to-accept wins. A single "current offer" field on
 * the booking could not express that.
 *
 * The 30-second deadline lives here as `expiresAt` and is enforced by a server
 * sweep — never by trusting a client to report its own timeout. A pro whose
 * phone slept through the window has not accepted, and a pro who sends
 * "accepted" forty seconds late must be refused.
 */

export interface OfferDoc {
  _id: string;
  bookingId: string;
  proId: string;

  /**
   * Which round of dispatch this was.
   *
   * Escalation widens the radius and offers again, so a booking can have
   * several rounds. Recorded because "nobody within 2 km accepted, then nobody
   * within 5 km" is the history an admin needs when a job goes unassigned.
   */
  round: number;
  /** The radius this round searched, in km. */
  radiusKm: number;

  /** Straight-line km at the time of the offer, or null when unknown. */
  distanceKm: number | null;

  status: "offered" | "accepted" | "declined" | "expired" | "taken";
  /** 30 seconds after it was created. */
  expiresAt: Date;
  respondedAt?: Date;

  createdAt: Date;
}

const offerSchema = new Schema<OfferDoc>(
  {
    _id: { type: String },
    bookingId: { type: String, required: true, index: true },
    proId: { type: String, required: true, index: true },
    round: { type: Number, default: 1 },
    radiusKm: { type: Number, required: true },
    distanceKm: { type: Number, default: null },
    status: {
      type: String,
      required: true,
      enum: ["offered", "accepted", "declined", "expired", "taken"],
      default: "offered",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

/** What `nextOffer` polls: this pro's one live offer. */
offerSchema.index({ proId: 1, status: 1, expiresAt: -1 });

/** One offer per pro per booking — a pro must not be alerted twice for a job. */
offerSchema.index({ bookingId: 1, proId: 1 }, { unique: true });

export const Offer = model<OfferDoc>("Offer", offerSchema);

/**
 * A job nobody accepted. Admin 9, 10.
 *
 * The agreement: *"2 minutes with no acceptance"* raises an alert. Its own
 * collection rather than an audit row, because this is a **queue an operator
 * works** — it has to be acknowledgeable, and an audit log is append-only by
 * design.
 */
export interface DispatchAlertDoc {
  _id: string;
  bookingId: string;
  bookingReference: string;
  serviceName: string;
  area: string;
  /** How many pros were offered it across all rounds. Zero is its own story. */
  prosNotified: number;
  /** Set when an operator has dealt with it — usually by assigning manually. */
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  at: Date;
}

const dispatchAlertSchema = new Schema<DispatchAlertDoc>(
  {
    _id: { type: String },
    bookingId: { type: String, required: true, unique: true },
    bookingReference: { type: String, required: true },
    serviceName: { type: String, required: true },
    area: { type: String, default: "" },
    prosNotified: { type: Number, default: 0 },
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: String },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

export const DispatchAlert = model<DispatchAlertDoc>(
  "DispatchAlert",
  dispatchAlertSchema,
);
