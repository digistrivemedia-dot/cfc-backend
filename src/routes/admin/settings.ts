import { Router } from "express";
import { badRequest } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
} from "../../middleware/auth";
import { Settings, SETTINGS_ID, getSettings } from "../../models/settings";
import { audit } from "../../models/audit";

/**
 * Admin 47 — platform settings.
 *
 * The editor behind §5. Every field here was previously a literal repeated
 * across screens that disagreed with each other; changing one value now
 * changes it everywhere, which is the whole point of the collection.
 *
 * Gated on `settings.edit_platform`, which only a super admin holds. These
 * values appear on customer-facing pages and on tax invoices.
 */
export const adminSettingsRouter = Router();

adminSettingsRouter.use(requireAuth, requireSection("settings"));

adminSettingsRouter.get("/", async (_req, res) => {
  res.json(await getSettings());
});

/** Fields an admin may write, and how each is validated. */
const STRINGS = [
  "supportPhone",
  "supportHours",
  "supportEmail",
  "brandName",
  "gstin",
  "registeredAddress",
  "cancellationPolicy",
] as const;

const NUMBERS = [
  "bookingHorizonDays",
  "slotMinutes",
  "slotStartHour",
  "slotEndHour",
  "gpsLimitMetres",
  "payoutMinimumPaise",
  "warrantyDefaultDays",
  "cancellationFeePaise",
] as const;

adminSettingsRouter.patch(
  "/",
  requirePermission("settings.edit_platform"),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    for (const key of STRINGS) {
      const v = body[key];
      // An empty string is a legitimate value — it means "not supplied yet",
      // and clearing a wrong support number must be possible.
      if (typeof v === "string") update[key] = v.trim();
    }

    for (const key of NUMBERS) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw badRequest(`${key} must be a whole number, zero or more.`, "BAD_VALUE");
      }
      update[key] = v;
    }

    if (Array.isArray(body["serviceAreas"])) {
      update["serviceAreas"] = (body["serviceAreas"] as unknown[])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim())
        .filter((a) => a !== "");
    }

    // The slot window has to be a window. Reversed hours produce a grid with
    // no slots in it, and the screen renders empty with nothing to explain it.
    const start = (update["slotStartHour"] ?? undefined) as number | undefined;
    const end = (update["slotEndHour"] ?? undefined) as number | undefined;
    const current = await getSettings();
    const from = start ?? current.slotStartHour;
    const to = end ?? current.slotEndHour;
    if (from >= to) {
      throw badRequest("The day must start before it ends.", "BAD_WINDOW");
    }
    if (to > 24) {
      throw badRequest("An hour is 0 to 24.", "BAD_WINDOW");
    }

    if (Object.keys(update).length === 0) {
      throw badRequest("Nothing to change.", "NO_CHANGE");
    }

    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: update }, { upsert: true });
    await audit(actorOf(req), "settings.updated", {
      subject: SETTINGS_ID,
      detail: update,
    });

    res.json(await getSettings());
  },
);
