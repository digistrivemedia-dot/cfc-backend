import { Router } from "express";
import { getSettings } from "../models/settings";
import { badRequest, notFound } from "../error";
import { slotsFor } from "../services/slots";
import type { PublicPro, Review as TypedReview, ServiceFaq } from "@cfc/types";
import {
  findService,
  listCategories,
  listServices,
  listSubCategories,
  searchCatalogue,
} from "../services/catalog-read";
import { Review, type ReviewDoc } from "../models/review";
import { Faq, type FaqDoc } from "../models/faq";
import { Pro, ratingOf, type ProDoc } from "../models/pro";
import { Service } from "../models/catalog";
import { PUBLIC_PREFIX } from "../uploads";

/**
 * Endpoints that need no token.
 *
 * Kept as its own group so "does this need auth?" is answered by which router a
 * route is mounted on, rather than by remembering to add a middleware. Anything
 * added here is public by construction — which is the point, and also the risk,
 * so the bar for adding is that an anonymous visitor is *meant* to read it.
 */
export const publicRouter = Router();

/**
 * `getServiceAreas` — the areas CFC operates in.
 *
 * Stage A's proof endpoint: it is the shortest possible path through every
 * piece of the new plumbing (live flag → `fetchJson` → CORS → Express → Mongo →
 * error envelope), so when it renders in the admin area filter, all of that is
 * verified at once rather than assumed.
 *
 * Public because the consumer app shows service areas to visitors who have not
 * signed in. Writing it is Admin 47, in Stage C.
 */
/**
 * §5 — the platform's own facts, as every screen should read them.
 *
 * Public because the footer, the support page and both home pages render
 * these before anyone signs in. Nothing here is sensitive; it is the content
 * that was previously hardcoded differently on each screen.
 *
 * Fields the client has not supplied come back as empty strings, and the
 * screens are expected to hide the row rather than print a placeholder. A
 * fabricated support number is one a customer actually rings.
 */
publicRouter.get("/config", async (_req, res) => {
  const s = await getSettings();
  res.json({
    supportPhone: s.supportPhone,
    supportHours: s.supportHours,
    supportEmail: s.supportEmail,
    brandName: s.brandName,
    warrantyDefaultDays: s.warrantyDefaultDays,
    cancellationPolicy: s.cancellationPolicy,
    cancellationFeePaise: s.cancellationFeePaise,
    serviceAreas: s.serviceAreas,
  });
});

publicRouter.get("/service-areas", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings.serviceAreas);
});

/**
 * The pincodes CFC accepts bookings from. **The authority on coverage.**
 *
 * Public because a visitor deciding whether to sign up needs to know before
 * they have an account, and the pro app's pincode picker reads the same list
 * so a pro cannot claim a pincode the platform does not serve.
 */
publicRouter.get("/service-pincodes", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings.servicePincodes);
});

/**
 * The catalogue, as a customer sees it.
 *
 * Every route here passes `activeOnly: true`. That single flag is the whole
 * difference between this and the admin's view of the same data, and it is the
 * reason the admin's switch means something: a category an operator switched
 * off disappears from the app while staying visible — and reversible — in the
 * panel.
 *
 * Public because the consumer app shows the catalogue to visitors who have not
 * signed in. Browsing does not require an account; booking does.
 */

publicRouter.get("/catalog/categories", async (_req, res) => {
  res.json(await listCategories({ activeOnly: true }));
});

publicRouter.get("/catalog/sub-categories", async (req, res) => {
  const categoryId =
    typeof req.query["categoryId"] === "string" ? req.query["categoryId"] : undefined;
  res.json(
    await listSubCategories({
      activeOnly: true,
      ...(categoryId ? { categoryId } : {}),
    }),
  );
});

publicRouter.get("/catalog/services", async (req, res) => {
  const q = req.query;
  res.json(
    await listServices({
      activeOnly: true,
      search: typeof q["search"] === "string" ? q["search"] : undefined,
      categoryId: typeof q["categoryId"] === "string" ? q["categoryId"] : undefined,
      subCategoryId:
        typeof q["subCategoryId"] === "string" ? q["subCategoryId"] : undefined,
    }),
  );
});

/**
 * One service.
 *
 * 404s for an inactive service as well as a missing one: to a customer
 * following an old link they are the same thing, and `getService` in the mock
 * layer already throws *"That service is not available."* for exactly this.
 */
/**
 * Arrival windows for a service on a day. Customer 15.
 *
 * Public: the slot grid is shown before a customer signs in, because being made
 * to sign in to find out whether anyone is free tomorrow is a step the 3-click
 * target cannot afford.
 */
publicRouter.get("/catalog/services/:id/slots", async (req, res) => {
  const date = req.query["date"];
  if (typeof date !== "string") {
    throw badRequest("Which date?", "MISSING_DATE");
  }
  const area = typeof req.query["area"] === "string" ? req.query["area"] : undefined;
  res.json(await slotsFor(req.params.id, date, area));
});

publicRouter.get("/catalog/services/:id", async (req, res) => {
  const service = await findService(req.params.id);
  if (!service || !service.active) {
    throw notFound("That service is not available.");
  }
  res.json(service);
});

// -- Reviews (Customer 2, 12, 13) --------------------------------------------

/**
 * Published reviews, newest first.
 *
 * Public, and deliberately so: the service page shows them to visitors who
 * have not signed in. Nothing identifying is returned — the author is already
 * shortened to "Priya V." at write time, and the area is context rather than a
 * claim about where CFC operates.
 *
 * `serviceName` rather than an id, because that is what the screens filter on
 * today and renaming the parameter would be a screen change for nothing.
 */
publicRouter.get("/reviews", async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  if (typeof q["serviceName"] === "string") filter["serviceName"] = q["serviceName"];
  if (typeof q["serviceId"] === "string") filter["serviceId"] = q["serviceId"];
  if (typeof q["proId"] === "string") filter["proId"] = q["proId"];

  // Capped: a service with thousands of reviews must not hand all of them to a
  // page that shows five.
  const raw = Number(q["limit"]);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 50;

  const rows = await Review.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<ReviewDoc[]>();

  const result: TypedReview[] = rows.map((r) => ({
    id: r._id,
    authorName: r.authorName,
    area: r.area,
    rating: r.rating,
    body: r.body,
    serviceName: r.serviceName,
    proId: r.proId,
    createdAt: r.createdAt.toISOString(),
    // Every row here is attached to an OTP-closed booking by construction —
    // there is no path that writes one otherwise.
    verified: true,
  }));
  res.json(result);
});

publicRouter.get("/reviews/count", async (req, res) => {
  const serviceName = req.query["serviceName"];
  if (typeof serviceName !== "string") {
    throw badRequest("Which service?", "MISSING_FIELD");
  }
  res.json({ count: await Review.countDocuments({ serviceName }) });
});

// -- A pro's public profile (Customer 13) ------------------------------------

/**
 * One professional, as a customer sees them.
 *
 * 404s for anyone not approved, or blocked. An unverified applicant has no
 * public profile at all, which is why `verified` can only ever be true here —
 * the guard above has already excluded every other case.
 *
 * Carries nothing financial and no phone number. A customer looking at who is
 * coming does not need either.
 */
publicRouter.get("/pros/:id", async (req, res) => {
  const pro = await Pro.findById(req.params.id).lean<ProDoc>();
  if (!pro || pro.blocked || pro.approvalStatus !== "approved") {
    throw notFound("That professional is not available.");
  }

  const names = await Service.find({ _id: { $in: pro.serviceIds } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();

  const result: PublicPro = {
    id: pro._id,
    photoUrl: pro.photoPath ? `${PUBLIC_PREFIX}/${pro.photoPath}` : null,
    name: pro.name,
    bio: pro.bio,
    services: names.map((n) => n.name),
    area: pro.areas[0] ?? "",
    rating: ratingOf(pro),
    jobsCompleted: pro.jobsCompleted,
    experienceYears: pro.experienceYears,
    verified: true,
    joinedAt: pro.createdAt.toISOString(),
  };
  res.json(result);
});

// -- FAQs (Customer 12, 40; Pro 31) -----------------------------------------

/**
 * FAQs for an audience, optionally narrowed to one service.
 *
 * Public: the service page and both help screens render these before anyone
 * signs in. `serviceId` returns that service's own questions **plus** every
 * general one, which is what makes a new service's FAQ section useful on day
 * one rather than empty.
 */
publicRouter.get("/faqs", async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const audience = q["audience"] === "pro" ? "pro" : "customer";

  const filter: Record<string, unknown> = { audience, active: true };
  if (typeof q["serviceId"] === "string") {
    filter["$or"] = [{ serviceId: null }, { serviceId: q["serviceId"] }];
  } else {
    filter["serviceId"] = null;
  }

  const rows = await Faq.find(filter)
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean<FaqDoc[]>();

  const result: ServiceFaq[] = rows.map((f) => ({
    id: f._id,
    serviceId: f.serviceId,
    question: f.question,
    answer: f.answer,
  }));
  res.json(result);
});

// -- Search (Customer 8, 9) --------------------------------------------------

/**
 * Customer search, and the type-ahead under the box.
 *
 * **Per-word, not per-phrase**, matching the mock this replaces: "ac repair"
 * has to find "AC service & repair", because every word the customer typed is
 * in that name and a real customer does not type them in the catalogue's
 * order. `$text` would be the index-backed option and it is the wrong one
 * here — it matches whole words only, so "clea" finds nothing while someone is
 * still typing "cleaning".
 *
 * Clause 4.8's search index is the `service_search` text index on the
 * collection; it serves the admin's full-word search. A regex AND across a
 * ~50-service catalogue is not what that clause is about.
 */
publicRouter.get("/search/services", async (req, res) => {
  const query = typeof req.query["q"] === "string" ? req.query["q"] : "";
  res.json(await searchCatalogue(query));
});

publicRouter.get("/search/suggest", async (req, res) => {
  const query = typeof req.query["q"] === "string" ? req.query["q"] : "";
  const raw = Number(req.query["limit"]);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 20) : 6;

  const rows = await searchCatalogue(query);
  res.json(
    rows
      .sort((a, b) => b.bookingCount - a.bookingCount)
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        name: s.name,
        subCategoryName: s.subCategoryName,
      })),
  );
});

/**
 * What people are actually booking.
 *
 * Derived from the real booking count, not a curated list — a hand-picked set
 * wearing a "trending" label is the kind of thing that quietly becomes untrue.
 * Before anyone has booked anything this is simply empty, which the search
 * screen already handles.
 */
publicRouter.get("/search/trending", async (req, res) => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 20) : 6;

  const services = await listServices({ activeOnly: true });
  res.json(
    services
      .filter((s) => s.bookingCount > 0)
      .sort((a, b) => b.bookingCount - a.bookingCount)
      .slice(0, limit)
      .map((s) => s.name),
  );
});
