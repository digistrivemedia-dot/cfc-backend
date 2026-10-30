import { Router } from "express";
import { badRequest, conflict, forbidden, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Booking, type BookingDoc } from "../../models/booking";
import { Customer, type CustomerDoc } from "../../models/customer";
import { Pro } from "../../models/pro";
import { Review, displayName } from "../../models/review";
import { newId } from "../../models/id";

/**
 * Customer 30 — submitting a rating.
 *
 * **The OTP gate is the point.** A rating is only possible against a booking
 * the pro closed with the customer's own completion code, so a review is
 * evidence of work that happened rather than something anyone can post. The
 * mock layer enforced this too; here it is enforced where it cannot be
 * bypassed by calling the endpoint directly.
 *
 * The two failures the screen already renders as specific sentences are kept
 * as the same two reasons — `not-completed` and `already-rated` — rather than
 * collapsed into one error, because the customer can act on the difference.
 */
export const consumerReviewRouter = Router();

consumerReviewRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

consumerReviewRouter.post("/", async (req, res) => {
  const actor = actorOf(req);
  const body = (req.body ?? {}) as {
    bookingId?: unknown;
    rating?: unknown;
    body?: unknown;
    chips?: unknown;
  };

  if (typeof body.bookingId !== "string" || body.bookingId.trim() === "") {
    throw badRequest("A booking is required.", "MISSING_FIELD");
  }
  // Whole stars only — the rating UI does not offer halves, and a 4.5 arriving
  // here would skew an average no screen can display.
  if (
    typeof body.rating !== "number" ||
    !Number.isInteger(body.rating) ||
    body.rating < 1 ||
    body.rating > 5
  ) {
    throw badRequest("A rating is 1 to 5 whole stars.", "BAD_RATING");
  }

  const booking = await Booking.findById(body.bookingId).lean<BookingDoc>();
  if (!booking) throw notFound("Booking not found.");

  // Checked against the token's customer, never a field in the body: otherwise
  // anyone could rate anyone else's job by guessing an id.
  if (booking.customerId !== actor.id) {
    throw forbidden("That booking is not yours.");
  }

  if (booking.status !== "completed") {
    throw conflict(
      "You can rate a job once it has been completed.",
      "NOT_COMPLETED",
    );
  }
  if (booking.rated) {
    throw conflict("You have already rated this job.", "ALREADY_RATED");
  }

  const chips = Array.isArray(body.chips)
    ? body.chips.filter((c): c is string => typeof c === "string").slice(0, 12)
    : [];

  const customer = await Customer.findById(actor.id).lean<CustomerDoc>();

  const review = await Review.create({
    _id: newId("rev"),
    bookingId: booking._id,
    customerId: actor.id,
    authorName: displayName(customer?.name ?? ""),
    area: booking.address.area,
    rating: body.rating,
    body: typeof body.body === "string" ? body.body.trim().slice(0, 2000) : "",
    chips,
    serviceId: booking.serviceId,
    serviceName: booking.serviceName,
    proId: booking.proId ?? null,
    createdAt: new Date(),
  });

  // Guarded on `rated: false`, so two taps racing each other cannot both move
  // the pro's rating. The unique index on bookingId is the backstop; this is
  // what keeps the counter honest.
  const claimed = await Booking.updateOne(
    { _id: booking._id, rated: false },
    { $set: { rated: true } },
  );

  if (claimed.modifiedCount === 1 && booking.proId) {
    // The running sum dispatch already orders by. Incremented rather than
    // recomputed: `ratingOf` divides these two, and a recount on every review
    // would read the whole collection to learn what `$inc` already knows.
    await Pro.updateOne(
      { _id: booking.proId },
      { $inc: { ratingSum: body.rating, ratingCount: 1 } },
    );
  }

  res.status(201).json({ ok: true, id: review._id });
});
