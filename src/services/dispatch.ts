import { Booking, newJobOtp, type BookingDoc } from "../models/booking";
import { DispatchAlert, Offer, type OfferDoc } from "../models/offer";
import { Pro, canReceiveOffers, ratingOf, type ProDoc } from "../models/pro";
import { newId } from "../models/id";
import { notify } from "../models/notification";
import { getSettings } from "../models/settings";

/**
 * The dispatch engine. Pro 12, Admin 9, Admin 10.
 *
 * **Every rule here is from the agreement. Nothing is invented.**
 *
 * | Rule | Value |
 * |---|---|
 * | Pros notified per job | 3 nearest, **simultaneously** — first to accept wins |
 * | Accept window | **30 s**, countdown shown, auto-reject on timeout |
 * | Auto-assign radius | **2 / 5 / 10 km**, admin-editable |
 * | Rating priority | At equal distance, the higher-rated pro is notified first |
 * | No-pro alert | **2 min** with no acceptance → admin |
 * | Auto offline | Offline on accept, online on completion |
 *
 * The one thing worth stating plainly: **the offer withholds the address, the
 * phone and the coordinates.** Three pros see an offer and two of them will not
 * attend — releasing the customer's door number would hand it to two strangers
 * who never came. A coordinate is an address by another name, so withholding
 * the street while publishing the latitude would defeat the point entirely.
 * They are released in the accept response, to the one pro attending.
 */

/** The accept window. From the agreement. */
export const OFFER_WINDOW_SECONDS = 30;

/** How many pros are alerted for one job. From the agreement. */
export const PROS_NOTIFIED_PER_JOB = 3;

/** Escalation ladder, in km. Admin-editable per the agreement (Admin 47). */
const RADIUS_LADDER_KM = [2, 5, 10];

/** How long a job may go unaccepted before an operator is told. */
const NO_PRO_ALERT_MS = 2 * 60 * 1000;

/**
 * Straight-line distance in km. Haversine.
 *
 * Only meaningful when both points are real. With `locationVerified: false` on
 * every address today (no Maps key — §7.1), this returns null and selection
 * falls back to area matching rather than ordering by coordinates that are
 * identical and wrong for every customer.
 */
function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/**
 * The pros to notify for a booking, best first.
 *
 * Ordering, in the agreement's words: nearest, and **at equal distance the
 * higher-rated pro first**. Where distance is unknown — which is every booking
 * until geocoding lands — rating is the whole ordering, and the area filter is
 * what keeps it local.
 *
 * Excludes any pro already offered this booking, so escalating a round does not
 * re-alert someone who declined.
 */
async function selectPros(
  booking: BookingDoc,
  radiusKm: number,
): Promise<{ pro: ProDoc; distanceKm: number | null }[]> {
  const alreadyOffered = await Offer.find({ bookingId: booking._id })
    .select({ proId: 1 })
    .lean<{ proId: string }[]>();
  const excluded = new Set(alreadyOffered.map((o) => o.proId));

  const candidates = await Pro.find({
    serviceIds: booking.serviceId,
    approvalStatus: "approved",
    blocked: false,
    // Only pros who have said they are ready. An offline pro is not in the
    // pool, and alerting them for work they cannot take costs them a penalty.
    online: true,
    _id: { $nin: [...excluded] },
    /**
     * Who covers this address.
     *
     * **Pincode first, area name as a fallback.** The name match was the only
     * test before, and it is fragile in a way that only shows up against a real
     * geocoder: OSM calls the area CFC knows as "Thillai Nagar" "Trichy Zone
     * IV", so a booking there matched no pro at all and sat unassigned.
     *
     * The `areas` branch stays for pros who registered before pincodes existed
     * and have not set any — dropping them from the pool overnight would be a
     * silent outage for them and for every customer in their area. They move
     * over as they set pincodes from their own profile.
     */
    $or: [
      { pincodes: booking.address.pincode },
      { pincodes: { $size: 0 }, areas: booking.address.area },
    ],
  }).lean<ProDoc[]>();

  const usable = candidates.filter(canReceiveOffers);

  const withDistance = usable.map((pro) => {
    const canMeasure =
      booking.address.locationVerified && pro.location !== undefined;
    const d = canMeasure
      ? distanceKm(
          { lat: booking.address.lat, lng: booking.address.lng },
          {
            lat: pro.location?.coordinates[1] ?? 0,
            lng: pro.location?.coordinates[0] ?? 0,
          },
        )
      : null;
    return { pro, distanceKm: d };
  });

  // Out-of-radius pros are dropped only when the distance is actually known.
  // Filtering on a fabricated distance would exclude the right pro.
  const inRadius = withDistance.filter(
    (c) => c.distanceKm === null || c.distanceKm <= radiusKm,
  );

  inRadius.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      const byDistance = a.distanceKm - b.distanceKm;
      if (byDistance !== 0) return byDistance;
    }
    // Equal distance, or no distance at all: higher rating first.
    const byRating = ratingOf(b.pro) - ratingOf(a.pro);
    if (byRating !== 0) return byRating;
    // Then fewer jobs first, so a new pro is not starved by the rating sort.
    return a.pro.jobsCompleted - b.pro.jobsCompleted;
  });

  return inRadius.slice(0, PROS_NOTIFIED_PER_JOB);
}

/**
 * Offers a booking to the next batch of pros.
 *
 * Called when a booking is placed, and again by the sweep when a round expires
 * with no acceptance. Returns how many pros were notified — zero means the
 * ladder is exhausted and the escalation path takes over.
 */
export async function dispatch(bookingId: string): Promise<number> {
  const booking = await Booking.findById(bookingId).lean<BookingDoc>();
  // Nothing to dispatch for a job already taken or cancelled.
  if (!booking || booking.status !== "pending" || booking.proId !== null) {
    return 0;
  }

  const rounds = await Offer.distinct("round", { bookingId });
  const nextRound = rounds.length + 1;
  const radiusKm =
    RADIUS_LADDER_KM[Math.min(nextRound - 1, RADIUS_LADDER_KM.length - 1)] ??
    RADIUS_LADDER_KM[RADIUS_LADDER_KM.length - 1] ??
    10;

  const selected = await selectPros(booking, radiusKm);
  if (selected.length === 0) return 0;

  const expiresAt = new Date(Date.now() + OFFER_WINDOW_SECONDS * 1000);

  // Created together so all three windows start at the same instant — that is
  // what "simultaneously" means, and a staggered start would quietly favour
  // whoever was written first.
  await Offer.insertMany(
    selected.map((c) => ({
      _id: newId("ofr"),
      bookingId,
      proId: c.pro._id,
      round: nextRound,
      radiusKm,
      distanceKm: c.distanceKm,
      status: "offered" as const,
      expiresAt,
      createdAt: new Date(),
    })),
    // A duplicate-key clash means this pro already had an offer for this
    // booking, which is not a reason to fail the whole round.
    { ordered: false },
  ).catch(() => undefined);

  // FCM push goes here once a Firebase project exists (§7.1). `PRO-OPEN-ITEMS`
  // 2.2 is the reason it is not optional: a web app cannot wake a sleeping
  // phone, so polling only works while the app is open. Until then the pro
  // app's `offer-listener` polls, which is enough to demonstrate the flow.

  return selected.length;
}

/**
 * Accepts an offer. **First-to-accept-wins, atomically.**
 *
 * The guard is in the filter, so Mongo decides: the first request matches a
 * pending, unassigned booking and takes it; the second matches nothing and gets
 * null. A read-then-write would let all three pros accept the same job.
 *
 * This is the only structural lock in the platform, and it is the reason §3 of
 * the plan concluded no Redis was needed.
 */
export async function acceptOffer(
  proId: string,
  offerId: string,
): Promise<
  | { kind: "accepted"; booking: BookingDoc }
  | { kind: "taken" }
  | { kind: "expired" }
  | { kind: "gone" }
> {
  const offer = await Offer.findOne({ _id: offerId, proId }).lean<OfferDoc>();
  if (!offer) return { kind: "gone" };

  if (offer.status === "taken") return { kind: "taken" };
  if (offer.status !== "offered") return { kind: "expired" };

  // Checked server-side. A pro whose device was asleep through the window has
  // not accepted, whatever their client believes.
  if (offer.expiresAt.getTime() < Date.now()) {
    await Offer.updateOne(
      { _id: offerId, status: "offered" },
      { $set: { status: "expired", respondedAt: new Date() } },
    );
    return { kind: "expired" };
  }

  const pro = await Pro.findById(proId).lean<ProDoc>();
  // Re-checked at accept, not only at offer: a pro blocked in the last thirty
  // seconds must not take a job.
  if (!pro || !canReceiveOffers(pro)) return { kind: "gone" };

  const claimed = await Booking.findOneAndUpdate(
    { _id: offer.bookingId, status: "pending", proId: null },
    {
      $set: {
        status: "assigned",
        proId,
        // Generated at assignment, but revealed to the customer only once the
        // pro is on the way — a code visible for days is a code that leaks.
        startOtp: newJobOtp(),
        completionOtp: newJobOtp(),
      },
      $push: {
        events: { at: new Date(), label: "Professional assigned", actor: pro.name },
      },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (claimed) {
    // Both sides are told, from the one place the assignment actually happens.
    // The customer's address and phone were withheld from the offer; they are
    // released to the pro in the accept response, not here.
    await notify({
      role: "customer",
      to: claimed.customerId,
      kind: "booking",
      title: `${pro.name} is on the way`,
      body: `Your ${claimed.serviceName} booking ${claimed.reference} has been assigned.`,
      href: `/bookings/${claimed.reference}`,
    });
    await notify({
      role: "pro",
      to: proId,
      kind: "job",
      title: "Job accepted",
      body: `${claimed.serviceName} — ${claimed.reference}.`,
      href: `/jobs/${claimed._id}`,
    });
  }

  if (!claimed) {
    // Someone else got there first. Not an error — the documented rule working.
    await Offer.updateOne(
      { _id: offerId },
      { $set: { status: "taken", respondedAt: new Date() } },
    );
    return { kind: "taken" };
  }

  await Offer.updateOne(
    { _id: offerId },
    { $set: { status: "accepted", respondedAt: new Date() } },
  );

  // Every other live offer for this booking is now dead, and the pros holding
  // them should be told rather than left with a countdown to nothing.
  await Offer.updateMany(
    { bookingId: offer.bookingId, _id: { $ne: offerId }, status: "offered" },
    { $set: { status: "taken", respondedAt: new Date() } },
  );

  // **Offline on accept.** From the agreement, and not a UI preference: a pro
  // on a job must not be in the pool that gets alerted.
  await Pro.updateOne({ _id: proId }, { $set: { online: false } });

  // An alert for this booking is resolved by the acceptance itself.
  await DispatchAlert.updateOne(
    { bookingId: offer.bookingId, acknowledgedAt: { $exists: false } },
    { $set: { acknowledgedAt: new Date(), acknowledgedBy: "system:accepted" } },
  );

  return { kind: "accepted", booking: claimed };
}

/**
 * Declines an offer.
 *
 * Recorded rather than discarded: a pattern of declines is what an admin
 * reviews. Re-dispatches immediately — the job should not wait out the
 * remaining seconds of a window the pro has already answered.
 */
export async function declineOffer(
  proId: string,
  offerId: string,
): Promise<void> {
  const offer = await Offer.findOneAndUpdate(
    { _id: offerId, proId, status: "offered" },
    { $set: { status: "declined", respondedAt: new Date() } },
  ).lean<OfferDoc>();

  if (!offer) return;

  // Only re-dispatch once every pro in this round has answered, or the job
  // would be offered to a fourth pro while two are still deciding.
  const outstanding = await Offer.countDocuments({
    bookingId: offer.bookingId,
    round: offer.round,
    status: "offered",
  });
  if (outstanding === 0) await dispatch(offer.bookingId);
}

/**
 * The sweep. Expires windows, escalates, and raises alerts.
 *
 * Runs on a timer rather than being triggered by requests, because the thing it
 * enforces is the **passage of time** — a booking nobody looked at still has to
 * escalate. Returns what it did, so the self-check can assert on it rather than
 * waiting on wall-clock time.
 */
export async function sweepDispatch(): Promise<{
  expired: number;
  redispatched: number;
  alerted: number;
}> {
  const now = new Date();

  const stale = await Offer.find({
    status: "offered",
    expiresAt: { $lt: now },
  }).lean<OfferDoc[]>();

  if (stale.length > 0) {
    await Offer.updateMany(
      { _id: { $in: stale.map((o) => o._id) }, status: "offered" },
      // An expiry is an auto-reject the pro did not make, which is worth
      // distinguishing from a decline they did — hence a separate status.
      { $set: { status: "expired", respondedAt: now } },
    );
  }

  // Bookings whose round has fully lapsed get the next, wider round.
  const bookingIds = [...new Set(stale.map((o) => o.bookingId))];
  let redispatched = 0;
  for (const bookingId of bookingIds) {
    const outstanding = await Offer.countDocuments({
      bookingId,
      status: "offered",
    });
    if (outstanding > 0) continue;
    const notified = await dispatch(bookingId);
    if (notified > 0) redispatched += 1;
  }

  // **2 minutes with no acceptance → admin.** Covers both "nobody accepted"
  // and "nobody was available to ask", which are different operational
  // problems with the same symptom.
  const settings = await getSettings();
  void settings;

  const cutoff = new Date(now.getTime() - NO_PRO_ALERT_MS);
  const stuck = await Booking.find({
    status: "pending",
    proId: null,
    createdAt: { $lt: cutoff },
  }).lean<BookingDoc[]>();

  let alerted = 0;
  for (const booking of stuck) {
    const existing = await DispatchAlert.findOne({
      bookingId: booking._id,
    }).lean();
    if (existing) continue;

    const prosNotified = await Offer.countDocuments({ bookingId: booking._id });
    await DispatchAlert.create({
      _id: newId("alr"),
      bookingId: booking._id,
      bookingReference: booking.reference,
      serviceName: booking.serviceName,
      area: booking.address.area,
      prosNotified,
      at: now,
    });
    alerted += 1;
  }

  return { expired: stale.length, redispatched, alerted };
}

/**
 * Admin 10 — manual assignment.
 *
 * For when auto-assign fails, which is what the alert queue exists to surface.
 * Deliberately **bypasses the radius and the online check**: an operator
 * assigning by hand has a reason, usually a phone call, and a tool that
 * second-guesses them is a tool they work around. It still refuses a pro who is
 * not approved or is blocked, because those are not operational judgements.
 */
export async function assignManually(
  bookingId: string,
  proId: string,
  byName: string,
): Promise<{ ok: true; booking: BookingDoc } | { ok: false; reason: string }> {
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro) return { ok: false, reason: "That professional no longer exists." };
  if (pro.approvalStatus !== "approved") {
    return { ok: false, reason: "That professional is not approved yet." };
  }
  if (pro.blocked) {
    return { ok: false, reason: "That professional is blocked." };
  }

  const claimed = await Booking.findOneAndUpdate(
    { _id: bookingId, status: "pending", proId: null },
    {
      $set: {
        status: "assigned",
        proId,
        startOtp: newJobOtp(),
        completionOtp: newJobOtp(),
      },
      $push: {
        events: {
          at: new Date(),
          label: `Assigned to ${pro.name} by ${byName}`,
          actor: byName,
          // Flagged as forced: an operator overrode dispatch, and the timeline
          // should say so rather than looking like an ordinary acceptance.
          forced: true,
        },
      },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (!claimed) {
    return {
      ok: false,
      reason: "That booking already has a professional, or is no longer pending.",
    };
  }

  await Offer.updateMany(
    { bookingId, status: "offered" },
    { $set: { status: "taken", respondedAt: new Date() } },
  );
  await Pro.updateOne({ _id: proId }, { $set: { online: false } });
  await DispatchAlert.updateOne(
    { bookingId, acknowledgedAt: { $exists: false } },
    { $set: { acknowledgedAt: new Date(), acknowledgedBy: byName } },
  );

  return { ok: true, booking: claimed };
}

/**
 * Bookings nobody took, that this pro could.
 *
 * ## Why this exists
 *
 * A booking is offered for 30 seconds, and `selectPros` **excludes any pro
 * already offered it** so an escalating round does not re-alert someone who
 * declined. Sound, until the roster is small: with one eligible pro, their
 * offer lapses, the next round finds nobody, and the booking sits `pending`
 * with `proId: null` for ever. The admin gets an alert; the pro who could do
 * the job has no way to take it.
 *
 * So this is the same filter dispatch uses, minus the exclusion: a lapsed or
 * declined offer stops meaning "never" once the alternative is the job dying.
 *
 * ## Why the slot has to be in the future
 *
 * A pro claiming yesterday's 10am job cannot do it and the customer has long
 * since given up. Those belong in the admin's alert queue to cancel or rebook,
 * not in a list of work to take.
 */
export async function unclaimedFor(proId: string): Promise<BookingDoc[]> {
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro || !canReceiveOffers(pro)) return [];

  return Booking.find({
    status: "pending",
    proId: null,
    // Only work this pro is approved for. The office approves skills, and a
    // list that ignored that would let anyone claim anything.
    serviceId: { $in: pro.serviceIds },
    // Not yet due. `scheduledAt` in the past is a job that cannot be done.
    scheduledAt: { $gt: new Date() },
    // Pincode, with the area fallback for pros who have not set pincodes yet —
    // the same rule the dispatch query uses, so the two never disagree about
    // who covers an address.
    $or: [
      { "address.pincode": { $in: pro.pincodes } },
      ...(pro.pincodes.length === 0
        ? [{ "address.area": { $in: pro.areas } }]
        : []),
    ],
  })
    .sort({ scheduledAt: 1 })
    .limit(50)
    .lean<BookingDoc[]>();
}

/** Why a claim failed, in the caller's terms. */
export type ClaimOutcome =
  | { kind: "claimed"; booking: BookingDoc }
  /** Another pro got there first, or dispatch assigned it. Not an error. */
  | { kind: "taken" }
  /** Not approved, blocked, wrong service, wrong area, or the slot has passed. */
  | { kind: "ineligible" };

/**
 * Takes an unclaimed booking.
 *
 * **Online is deliberately not required.** Being online means "send me work";
 * opening this list and tapping one job is the pro actively asking for that
 * one, so the flag would be friction with no safety behind it. Approved and
 * not blocked still apply, re-checked here rather than trusted from the list.
 *
 * The assignment is the same single atomic update `acceptOffer` uses, so a
 * claim and an accept cannot produce two differently-shaped bookings — and two
 * pros tapping at once is resolved by the database, not by a check that races.
 */
export async function claimBooking(
  proId: string,
  bookingId: string,
): Promise<ClaimOutcome> {
  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro || !canReceiveOffers(pro)) return { kind: "ineligible" };

  const booking = await Booking.findById(bookingId).lean<BookingDoc>();
  if (!booking) return { kind: "ineligible" };
  if (booking.proId !== null || booking.status !== "pending") {
    return { kind: "taken" };
  }
  if (!pro.serviceIds.includes(booking.serviceId)) return { kind: "ineligible" };
  if (booking.scheduledAt.getTime() <= Date.now()) return { kind: "ineligible" };

  const covers =
    pro.pincodes.length > 0
      ? pro.pincodes.includes(booking.address.pincode)
      : pro.areas.includes(booking.address.area);
  if (!covers) return { kind: "ineligible" };

  const claimed = await Booking.findOneAndUpdate(
    { _id: bookingId, status: "pending", proId: null },
    {
      $set: {
        status: "assigned",
        proId,
        startOtp: newJobOtp(),
        completionOtp: newJobOtp(),
      },
      $push: {
        events: {
          at: new Date(),
          // Named differently from a dispatched assignment on purpose: the
          // timeline should show that nobody was sent this job, somebody took
          // it. That is a different operational story.
          label: "Professional claimed this job",
          actor: pro.name,
        },
      },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (!claimed) return { kind: "taken" };

  // The admin was told this booking was stuck. It no longer is.
  await DispatchAlert.deleteOne({ bookingId });

  await notify({
    role: "customer",
    to: claimed.customerId,
    kind: "booking",
    title: `${pro.name} is on the way`,
    body: `Your ${claimed.serviceName} booking ${claimed.reference} has been assigned.`,
    href: `/bookings/${claimed.reference}`,
  });

  // Any offer this pro still holds for it is now spent rather than left
  // sitting as "offered" against a booking that is assigned.
  await Offer.updateMany(
    { bookingId, status: "offered" },
    { $set: { status: "taken", respondedAt: new Date() } },
  );

  return { kind: "claimed", booking: claimed };
}
