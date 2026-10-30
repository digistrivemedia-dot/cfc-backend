import { Router } from "express";
import type { ProAvailability, ProService } from "@cfc/types";
import { WEEKDAYS } from "@cfc/types";
import { badRequest, forbidden, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Pro, type ProDoc } from "../../models/pro";
import { Service, type ServiceDoc } from "../../models/catalog";
import { SubCategory, Category } from "../../models/catalog";
import { Booking } from "../../models/booking";
import { settle } from "../../services/job-lifecycle";
import { param } from "../../params";

/**
 * Pro 28–29 — the services a pro is taking, and their week.
 *
 * Everything is scoped to the token. The mock signatures take a `proId` and
 * the live path ignores it, so no screen changes and no pro can read or edit
 * another's schedule by passing a different id.
 */
export const proProfileRouter = Router();

proProfileRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "pro") {
    next(forbidden());
    return;
  }
  next();
});

/**
 * The services this pro is registered for, with their own on/off switch.
 *
 * The **rate is admin-set** and shown so the pro can see what the work pays;
 * `netPaise` is what they keep after commission, computed with the same
 * engine that settles a real job rather than a second copy of the rule.
 */
proProfileRouter.get("/services", async (req, res) => {
  const pro = await Pro.findById(actorOf(req).id).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const services = await Service.find({ _id: { $in: pro.serviceIds } })
    .lean<ServiceDoc[]>();
  const subs = await SubCategory.find({
    _id: { $in: services.map((s) => s.subCategoryId) },
  })
    .select({ categoryId: 1 })
    .lean<{ _id: string; categoryId: string }[]>();
  const cats = await Category.find({ _id: { $in: subs.map((s) => s.categoryId) } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();

  const catOf = new Map(subs.map((s) => [s._id, s.categoryId]));
  const catName = new Map(cats.map((c) => [c._id, c.name]));

  // Jobs per service, for the "is this worth keeping on" column.
  const counts = await Booking.aggregate<{ _id: string; n: number }>([
    { $match: { proId: pro._id, status: "completed" } },
    { $group: { _id: "$serviceId", n: { $sum: 1 } } },
  ]);
  const doneBy = new Map(counts.map((c) => [c._id, c.n]));

  const disabled = new Set(pro.disabledServiceIds ?? []);

  const result: ProService[] = services.map((s) => {
    // The same function that settles a real job, not a second copy of the rule.
    const { netPaise } = settle(s.basePricePaise, pro.jobsCompleted);
    return {
      serviceId: s._id,
      serviceName: s.name,
      categoryName: catName.get(catOf.get(s.subCategoryId) ?? "") ?? "",
      ratePaise: s.basePricePaise,
      netPaise,
      // Stored as exceptions, so a service the admin adds is on by default.
      enabled: !disabled.has(s._id),
      jobsCompleted: doneBy.get(s._id) ?? 0,
    };
  });
  res.json(result);
});

proProfileRouter.put("/services/:serviceId", async (req, res) => {
  const proId = actorOf(req).id;
  const serviceId = param(req, "serviceId");
  const enabled = (req.body as { enabled?: unknown })?.enabled === true;

  const pro = await Pro.findById(proId).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");
  if (!pro.serviceIds.includes(serviceId)) {
    // A pro cannot switch on work they were never registered for — that is
    // the admin's decision at approval, not theirs.
    throw badRequest("You are not registered for that service.", "NOT_REGISTERED");
  }

  await Pro.updateOne(
    { _id: proId },
    enabled
      ? { $pull: { disabledServiceIds: serviceId } }
      : { $addToSet: { disabledServiceIds: serviceId } },
  );
  res.json({ enabled });
});

/** Seven days, Monday first, defaulting to a working week. */
function defaultWeek(): ProAvailability["days"] {
  return WEEKDAYS.map((day) => ({
    day,
    working: day !== "sun",
    from: "09:00",
    to: "18:00",
  }));
}

proProfileRouter.get("/availability", async (req, res) => {
  const pro = await Pro.findById(actorOf(req).id).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const stored = pro.availability;
  const result: ProAvailability = {
    // A pro who has never opened the screen gets a sensible week rather than
    // seven blank rows that read as "never available".
    days: stored?.days?.length
      ? (stored.days as ProAvailability["days"])
      : defaultWeek(),
    holidayMode: stored?.holidayMode ?? false,
    holidayUntil: stored?.holidayUntil?.toISOString() ?? null,
  };
  res.json(result);
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

proProfileRouter.put("/availability", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rawDays = Array.isArray(b["days"]) ? b["days"] : [];

  const days = rawDays.map((d) => {
    const row = (d ?? {}) as Record<string, unknown>;
    const day = String(row["day"] ?? "");
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      throw badRequest("Unknown day.", "BAD_DAY");
    }
    const from = String(row["from"] ?? "09:00");
    const to = String(row["to"] ?? "18:00");
    if (!TIME.test(from) || !TIME.test(to)) {
      throw badRequest("Times are 24-hour HH:MM.", "BAD_TIME");
    }
    const working = row["working"] === true;
    // Only checked for a working day: an off day's times are ignored, and
    // rejecting leftover values the pro cannot see would be unfixable.
    if (working && from >= to) {
      throw badRequest("A day must start before it ends.", "BAD_WINDOW");
    }
    return { day, working, from, to };
  });

  if (days.length !== WEEKDAYS.length) {
    throw badRequest("All seven days are required.", "INCOMPLETE_WEEK");
  }

  const holidayRaw = b["holidayUntil"];
  const holidayUntil =
    typeof holidayRaw === "string" && holidayRaw !== "" ? new Date(holidayRaw) : null;
  if (holidayUntil !== null && Number.isNaN(holidayUntil.getTime())) {
    throw badRequest("Invalid date.", "BAD_DATE");
  }

  await Pro.updateOne(
    { _id: actorOf(req).id },
    {
      $set: {
        availability: {
          days,
          holidayMode: b["holidayMode"] === true,
          holidayUntil,
        },
      },
    },
  );

  const result: ProAvailability = {
    days: days as ProAvailability["days"],
    holidayMode: b["holidayMode"] === true,
    holidayUntil: holidayUntil?.toISOString() ?? null,
  };
  res.json(result);
});
