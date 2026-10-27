import { Router } from "express";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
  scopeArea,
} from "../../middleware/auth";
import { Booking, type BookingDoc } from "../../models/booking";
import { DispatchAlert, Offer, type DispatchAlertDoc, type OfferDoc } from "../../models/offer";
import { Pro, ratingOf, type ProDoc } from "../../models/pro";
import { audit } from "../../models/audit";
import { assignManually, sweepDispatch } from "../../services/dispatch";

/**
 * Admin 9, 10 — the live map and manual assignment.
 *
 * `ADMIN-PENDING.md` calls this the largest single gap in the admin build, and
 * the reason is that it is the screen an operator opens when dispatch has
 * already failed. So the endpoints here answer two questions: *what is
 * happening right now*, and *what do I do about the job nobody took*.
 */
export const adminDispatchRouter = Router();

adminDispatchRouter.use(requireAuth, requireSection("bookings"));

/**
 * Admin 9 — everything in flight.
 *
 * A single endpoint rather than three, because the map shows pros and jobs
 * together and two requests would let them disagree by a poll interval. Polled
 * every five seconds by the screen; §3 of the plan settled on that over a
 * socket, and this is the endpoint it meant.
 */
adminDispatchRouter.get("/live", async (req, res) => {
  const area = scopeArea(req);

  const [pros, bookings] = await Promise.all([
    Pro.find({
      approvalStatus: "approved",
      blocked: false,
      ...(area ? { areas: area } : {}),
    }).lean<ProDoc[]>(),
    Booking.find({
      status: { $in: ["pending", "assigned", "in_progress"] },
      ...(area ? { "address.area": area } : {}),
    }).lean<BookingDoc[]>(),
  ]);

  res.json({
    pros: pros.map((p) => ({
      id: p._id,
      name: p.name,
      online: p.online,
      area: p.areas[0] ?? "",
      rating: ratingOf(p),
      // Null for a pro who has never pinged. The map must draw nothing rather
      // than a pin at (0,0) in the Gulf of Guinea.
      point: p.location
        ? { lat: p.location.coordinates[1], lng: p.location.coordinates[0] }
        : null,
    })),
    jobs: bookings.map((b) => ({
      id: b._id,
      reference: b.reference,
      serviceName: b.serviceName,
      status: b.status,
      area: b.address.area,
      point: { lat: b.address.lat, lng: b.address.lng },
      /**
       * Whether that point can be trusted.
       *
       * False for every booking until geocoding lands (§7.1), because the
       * address form sends one hardcoded coordinate for everyone. The map
       * should cluster these as "area only" rather than drawing a dozen pins
       * on the same wrong spot and implying precision it does not have.
       */
      locationVerified: b.address.locationVerified,
      proId: b.proId,
      scheduledAt: b.scheduledAt.toISOString(),
    })),
  });
});

/**
 * The jobs nobody accepted. Admin 9, 10.
 *
 * The queue an operator actually works. Unacknowledged first, because an
 * acknowledged alert is history.
 */
adminDispatchRouter.get("/alerts", async (_req, res) => {
  const rows = await DispatchAlert.find({ acknowledgedAt: { $exists: false } })
    .sort({ at: 1 })
    .lean<DispatchAlertDoc[]>();

  res.json(
    rows.map((a) => ({
      id: a._id,
      bookingId: a.bookingId,
      bookingReference: a.bookingReference,
      serviceName: a.serviceName,
      area: a.area,
      prosNotified: a.prosNotified,
      at: a.at.toISOString(),
      // Zero notified and "three declined" are different problems with the
      // same symptom, so the queue says which.
      reason:
        a.prosNotified === 0
          ? "No professional was available to ask"
          : `${a.prosNotified} notified, none accepted`,
    })),
  );
});

/** Who could take this job, for the manual-assignment picker. */
adminDispatchRouter.get("/candidates/:bookingId", async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean<BookingDoc>();
  if (!booking) throw notFound("That booking could not be found.");

  const offered = await Offer.find({ bookingId: booking._id }).lean<OfferDoc[]>();
  const byPro = new Map(offered.map((o) => [o.proId, o.status]));

  // Deliberately **not** filtered to the booking's area or to online pros: an
  // operator assigning by hand usually has a phone call behind it, and a picker
  // that hides the pro they just spoke to is a picker they work around.
  const pros = await Pro.find({
    serviceIds: booking.serviceId,
    approvalStatus: "approved",
    blocked: false,
  }).lean<ProDoc[]>();

  res.json(
    pros.map((p) => ({
      id: p._id,
      name: p.name,
      phone: p.phone,
      areas: p.areas,
      online: p.online,
      rating: ratingOf(p),
      jobsCompleted: p.jobsCompleted,
      servesThisArea: p.areas.includes(booking.address.area),
      // So an operator can see this pro already declined rather than wondering
      // why dispatch skipped them.
      previousOffer: byPro.get(p._id) ?? null,
    })),
  );
});

/**
 * Admin 10 — assign a job by hand.
 *
 * Gated on `bookings.override_status`: forcing an assignment is the same kind
 * of act as forcing a status, and the agreement does not delegate either.
 */
adminDispatchRouter.post(
  "/assign",
  requirePermission("bookings.override_status"),
  async (req, res) => {
    const body = (req.body ?? {}) as { bookingId?: unknown; proId?: unknown };
    if (typeof body.bookingId !== "string" || typeof body.proId !== "string") {
      throw badRequest("Which booking, and which professional?", "MISSING_FIELD");
    }

    const actor = actorOf(req);
    const result = await assignManually(body.bookingId, body.proId, actor.name);

    if (!result.ok) throw conflict(result.reason, "ASSIGN_FAILED");

    await audit(actor, "booking.assigned_manually", {
      subject: body.bookingId,
      detail: { proId: body.proId, reference: result.booking.reference },
    });

    res.json({
      id: result.booking._id,
      reference: result.booking.reference,
      status: result.booking.status,
      proId: result.booking.proId,
    });
  },
);

/**
 * Runs the sweep now.
 *
 * The timer does this on its own; the endpoint exists so an operator can force
 * a retry on a stuck job rather than waiting, and so the self-check can assert
 * on expiry and escalation without sleeping through 30 real seconds.
 */
adminDispatchRouter.post(
  "/sweep",
  requirePermission("bookings.override_status"),
  async (_req, res) => {
    res.json(await sweepDispatch());
  },
);
