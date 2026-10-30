import { Schema, model } from "mongoose";

/**
 * Customer 30 — a rating of a completed job.
 *
 * **OTP-gated by construction.** A review can only be written against a
 * booking the pro closed with the customer's own completion code, so every row
 * here is attached to work that demonstrably happened. That is the whole
 * reason these can be shown as social proof rather than as marketing copy, and
 * `verified` records it rather than being a flag an admin can set by hand.
 *
 * Service and pro names are **copied at review time**, like the booking's own
 * copies: renaming a service later must not rewrite the history of what people
 * said about it.
 */

export interface ReviewDoc {
  _id: string;
  bookingId: string;
  customerId: string;

  /**
   * A display name, shortened for publication ("Priya V.").
   *
   * Computed on write, never the stored full name — a full name beside an area
   * is more identifying than a review needs to be, and deriving it on read
   * would mean every caller has to remember to.
   */
  authorName: string;
  /** Where the job happened. Context, never a claim about where CFC operates. */
  area: string;

  /** 1–5, whole stars. The rating UI does not offer halves. */
  rating: number;
  body: string;
  /** The tapped chips, kept apart from the written body. */
  chips: string[];

  serviceId: string;
  serviceName: string;
  /** Null where the job was never assigned to a pro on the platform. */
  proId: string | null;

  /**
   * The pro's public answer, Pro 30.
   *
   * One reply, not a thread: a review page is not a conversation, and a
   * back-and-forth under a one-star rating helps nobody. Replacing it is
   * allowed — a pro who answers badly at 11pm should be able to fix it.
   */
  proReply?: { body: string; at: Date };

  createdAt: Date;
}

const reviewSchema = new Schema<ReviewDoc>(
  {
    _id: { type: String },
    // Unique: one review per booking. The submit route checks the booking's
    // `rated` flag first for a clean error, but two taps racing each other get
    // past a check and not past an index.
    bookingId: { type: String, required: true, unique: true },
    customerId: { type: String, required: true, index: true },
    authorName: { type: String, required: true },
    area: { type: String, default: "" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    body: { type: String, default: "" },
    chips: { type: [String], default: [] },
    serviceId: { type: String, required: true, index: true },
    serviceName: { type: String, required: true },
    proId: { type: String, default: null, index: true },
    proReply: {
      type: new Schema(
        { body: { type: String, required: true }, at: { type: Date, required: true } },
        { _id: false },
      ),
      default: undefined,
    },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

/** Both list views are newest-first within one subject. */
reviewSchema.index({ serviceId: 1, createdAt: -1 });
reviewSchema.index({ proId: 1, createdAt: -1 });

export const Review = model<ReviewDoc>("Review", reviewSchema);

/**
 * "Priya Venkatesan" -> "Priya V." — and a one-word name is left alone.
 *
 * Falls back to "A customer" rather than publishing an empty byline: the name
 * is optional on a customer record, and a review signed by nobody reads as
 * fabricated.
 */
export function displayName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A customer";
  if (parts.length === 1) return parts[0] as string;
  return `${parts[0]} ${(parts[parts.length - 1] as string)[0]}.`;
}

/**
 * Average rating and count for a set of services or pros, in one query.
 *
 * Aggregated on read rather than kept as a counter on the subject. A stored
 * average drifts the moment a review is removed for abuse, and these lists are
 * tens of rows — the cost of being right here is a `$group`.
 *
 * `ponytail:` *aggregate per request. Cache or denormalise onto the service if
 * a profiler says this is hot — a catalogue of ~50 services is not.*
 */
export async function ratingsBy(
  field: "serviceId" | "proId",
  ids: string[],
): Promise<Map<string, { rating: number; reviewCount: number }>> {
  if (ids.length === 0) return new Map();

  const rows = await Review.aggregate<{
    _id: string;
    sum: number;
    count: number;
  }>([
    { $match: { [field]: { $in: ids } } },
    { $group: { _id: `$${field}`, sum: { $sum: "$rating" }, count: { $sum: 1 } } },
  ]);

  return new Map(
    rows.map((r) => [
      r._id,
      {
        // One decimal, the precision every star display actually renders.
        rating: Math.round((r.sum / r.count) * 10) / 10,
        reviewCount: r.count,
      },
    ]),
  );
}
