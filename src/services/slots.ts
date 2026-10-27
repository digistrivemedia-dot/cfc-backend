import { Booking } from "../models/booking";
import { getSettings } from "../models/settings";
import { Pro, canReceiveOffers, type ProDoc } from "../models/pro";
import type { Slot } from "@cfc/types";

/**
 * Arrival windows for one service on one day. Customer 15.
 *
 * The mock generated these from a seeded hash, which was the right call with no
 * data behind it. This derives them from what actually constrains a window: the
 * clock, the booking horizon, and how much is already booked into it.
 *
 * **Having no approved pro does not close the grid.** An earlier version
 * refused every slot when no pro offered the service, which looks careful and
 * contradicts the agreement: a booking is placed first, then dispatch notifies
 * three pros, and *"2 minutes with no acceptance"* raises an admin alert. The
 * shortfall is an operational event with a defined response, not a reason to
 * tell a customer the service does not exist. Gating here would also mean a
 * brand-new platform could take no bookings at all, which is backwards — the
 * bookings are what justify recruiting the pros.
 *
 * Window length and the hours offered come from settings, not literals: §7.2
 * records both as assumptions the client has not confirmed.
 */
export async function slotsFor(
  serviceId: string,
  isoDate: string,
  area?: string,
): Promise<Slot[]> {
  const settings = await getSettings();
  const { slotMinutes, slotStartHour, slotEndHour } = settings;

  const day = new Date(isoDate);
  if (Number.isNaN(day.getTime())) return [];
  day.setHours(0, 0, 0, 0);

  // How many pros could take this work at all. Capacity, not a guess.
  const candidates = await Pro.find({
    serviceIds: serviceId,
    approvalStatus: "approved",
    blocked: false,
    ...(area ? { areas: area } : {}),
  }).lean<ProDoc[]>();

  /**
   * How many jobs can sit in one window.
   *
   * The approved pros who could take this work, with a floor of one: with no
   * pro yet, a window still accepts a booking (see above) but not an unlimited
   * number of them, because overbooking a single window is a real problem
   * whereas having none to dispatch is a solvable one.
   */
  const capacity = Math.max(1, candidates.filter(canReceiveOffers).length);

  const dayEnd = new Date(day);
  dayEnd.setHours(23, 59, 59, 999);

  // Only bookings that still need a pro's time. A cancelled one frees its slot.
  const sameDay = await Booking.find({
    serviceId,
    scheduledAt: { $gte: day, $lte: dayEnd },
    status: { $in: ["pending", "assigned", "in_progress"] },
  })
    .select({ scheduledAt: 1 })
    .lean<{ scheduledAt: Date }[]>();

  const now = Date.now();
  const slots: Slot[] = [];

  for (let hour = slotStartHour; hour < slotEndHour; hour += slotMinutes / 60) {
    const startsAt = new Date(day);
    startsAt.setHours(Math.floor(hour), (hour % 1) * 60, 0, 0);

    // A window already under way cannot be booked. This is the thing a
    // customer notices immediately if it is wrong.
    const started = startsAt.getTime() <= now;

    const windowEnd = startsAt.getTime() + slotMinutes * 60_000;
    const taken = sameDay.filter((b) => {
      const t = b.scheduledAt.getTime();
      return t >= startsAt.getTime() && t < windowEnd;
    }).length;

    slots.push({
      startsAt: startsAt.toISOString(),
      durationMinutes: slotMinutes,
      available: !started && taken < capacity,
    });
  }

  return slots;
}
