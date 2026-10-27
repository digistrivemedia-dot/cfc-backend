import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { badRequest, conflict, forbidden, notFound } from "../../error";
import { can } from "@cfc/types";
import { actorOf, requireAuth, requirePermission, requireSection } from "../../middleware/auth";
import { imageUpload, publicPathFor, verifyImageBytes } from "../../middleware/upload";
import {
  Category,
  CommissionRule,
  Service,
  SubCategory,
  type ServiceDoc,
} from "../../models/catalog";
import { newId } from "../../models/id";
import { param } from "../../params";
import { audit } from "../../models/audit";
import {
  findService,
  listCategories,
  listCommissionRules,
  listPricingRules,
  listServices,
  listSubCategories,
} from "../../services/catalog-read";

/**
 * Admin 22–29 — the service catalogue.
 *
 * *"All categories, sub-categories, services and pricing are created and
 * managed entirely by the Admin. Nothing is hardcoded."* This router is that
 * sentence.
 *
 * Mounted behind `requireAuth` + `requireSection("services")`, so an area admin
 * — whose role list does not include `services` — gets a 403 on every route
 * here regardless of what their sidebar offered. The money-touching routes add
 * `requirePermission`, because opening the section and changing what something
 * costs are different questions (a sub-admin does neither: `services` is not in
 * their role list either).
 */
export const adminCatalogRouter = Router();

adminCatalogRouter.use(requireAuth, requireSection("services"));

// -- helpers -----------------------------------------------------------------

/** Reads a required trimmed string, or 400s with a readable message. */
function str(body: unknown, field: string, label: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${label} is required.`, "MISSING_FIELD");
  }
  return value.trim();
}

function optionalStr(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value.trim() : undefined;
}

function bool(body: unknown, field: string, fallback: boolean): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Reads a money field in paise.
 *
 * Rejects a non-integer rather than rounding it. `priceDeltaPaise: 49.5` is a
 * caller that has confused rupees with paise, and silently rounding would bake
 * a half-paise error into a price nobody notices until a settlement does not
 * reconcile. Negative is refused except where a delta is meant to be.
 */
function paise(
  body: unknown,
  field: string,
  options: { fallback?: number; allowNegative?: boolean } = {},
): number {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (value === undefined || value === null) {
    if (options.fallback !== undefined) return options.fallback;
    throw badRequest(`${field} is required.`, "MISSING_FIELD");
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest(`${field} must be a whole number of paise.`, "BAD_AMOUNT");
  }
  if (!options.allowNegative && value < 0) {
    throw badRequest(`${field} cannot be negative.`, "BAD_AMOUNT");
  }
  return value;
}

// -- Categories (Admin 22, 23) ------------------------------------------------

adminCatalogRouter.get("/categories", async (_req, res) => {
  res.json(await listCategories());
});

adminCatalogRouter.post("/categories", async (req, res) => {
  const name = str(req.body, "name", "Name");

  // Two categories with the same name is an operator mistake, not a feature:
  // the customer-facing grid would show the same word twice with different
  // services beneath each. Case-insensitive, because "AC Repair" and "AC
  // repair" are the same mistake.
  const clash = await Category.findOne({
    name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  }).lean();
  if (clash) throw conflict(`A category called "${name}" already exists.`, "DUPLICATE");

  // Appended to the end unless told otherwise, so a new category never
  // displaces the merchandising order an operator has already set.
  const last = await Category.findOne().sort({ sortOrder: -1 }).lean();
  const sortOrder = (last?.sortOrder ?? 0) + 1;

  const doc = await Category.create({
    _id: newId("cat"),
    name,
    iconName: optionalStr(req.body, "iconName") || "Wrench",
    description: optionalStr(req.body, "description") ?? "",
    sortOrder,
    active: bool(req.body, "active", true),
  });

  await audit(actorOf(req), "catalog.category.created", {
    subject: doc._id,
    detail: { name },
  });

  res.status(201).json({
    id: doc._id,
    name: doc.name,
    iconName: doc.iconName,
    description: doc.description,
    sortOrder: doc.sortOrder,
    active: doc.active,
    serviceCount: 0,
  });
});

/**
 * Admin 22 — drag-to-reorder.
 *
 * Takes the **whole ordered list** of ids rather than one id and a position.
 * The screen already renumbers from position on every change, and a full list
 * cannot land the database in a state with two categories at order 3 — which is
 * what a sequence of individual moves does if one request fails.
 */
adminCatalogRouter.patch("/categories/reorder", async (req, res) => {
  const ids = (req.body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw badRequest("Send the full ordered list of category ids.", "BAD_ORDER");
  }

  const known = await Category.find({ _id: { $in: ids } }).select({ _id: 1 }).lean();
  if (known.length !== ids.length) {
    throw badRequest("That list refers to a category that no longer exists.", "BAD_ORDER");
  }

  await Category.bulkWrite(
    (ids as string[]).map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index + 1 } } },
    })),
  );

  await audit(actorOf(req), "catalog.category.reordered", {
    detail: { order: ids },
  });

  res.json(await listCategories());
});

// NOTE: `/categories/reorder` MUST stay above `/categories/:id`.
// Express matches in declaration order, so with `:id` first a reorder request
// is captured as a category whose id is the literal string "reorder" — a 404
// that looks like a missing record rather than a routing mistake.
adminCatalogRouter.patch("/categories/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await Category.findById(id).lean();
  if (!existing) throw notFound("That category no longer exists.");

  const patch: Record<string, unknown> = {};
  const name = optionalStr(req.body, "name");
  if (name !== undefined && name !== "") patch["name"] = name;
  const iconName = optionalStr(req.body, "iconName");
  if (iconName) patch["iconName"] = iconName;
  const description = optionalStr(req.body, "description");
  if (description !== undefined) patch["description"] = description;
  if (typeof (req.body as { active?: unknown })?.active === "boolean") {
    patch["active"] = (req.body as { active: boolean }).active;
  }
  if (typeof (req.body as { sortOrder?: unknown })?.sortOrder === "number") {
    patch["sortOrder"] = (req.body as { sortOrder: number }).sortOrder;
  }

  await Category.updateOne({ _id: id }, { $set: patch });

  await audit(actorOf(req), "catalog.category.updated", {
    subject: id,
    // Both sides recorded: "active changed" is useless in a dispute without
    // knowing which way.
    detail: { before: { name: existing.name, active: existing.active }, patch },
  });

  const all = await listCategories();
  const updated = all.find((c) => c.id === id);
  if (!updated) throw notFound("That category no longer exists.");
  res.json(updated);
});

/**
 * Deleting a category.
 *
 * **Refused while anything still hangs off it.** Cascading would silently
 * delete services an admin has priced and customers may have booked; orphaning
 * them would leave services that no browse screen can reach. Neither is a
 * decision a DELETE should make on its own, so the error names what is in the
 * way and the admin deals with it.
 */
adminCatalogRouter.delete("/categories/:id", async (req, res) => {
  const { id } = req.params;
  const subs = await SubCategory.countDocuments({ categoryId: id });
  if (subs > 0) {
    throw conflict(
      `That category still has ${subs} sub-categor${subs === 1 ? "y" : "ies"}. ` +
        "Move or remove them first, or switch the category off to hide it.",
      "NOT_EMPTY",
    );
  }

  const deleted = await Category.findByIdAndDelete(id).lean();
  if (!deleted) throw notFound("That category no longer exists.");

  await audit(actorOf(req), "catalog.category.deleted", {
    subject: id,
    detail: { name: deleted.name },
  });
  res.status(204).end();
});

// -- Sub-categories (Admin 24, 25) --------------------------------------------

adminCatalogRouter.get("/sub-categories", async (req, res) => {
  const categoryId = typeof req.query["categoryId"] === "string" ? req.query["categoryId"] : undefined;
  res.json(await listSubCategories(categoryId ? { categoryId } : {}));
});

adminCatalogRouter.post("/sub-categories", async (req, res) => {
  const name = str(req.body, "name", "Name");
  const categoryId = str(req.body, "categoryId", "Parent category");

  const parent = await Category.findById(categoryId).lean();
  if (!parent) throw badRequest("That parent category does not exist.", "BAD_PARENT");

  const doc = await SubCategory.create({
    _id: newId("sub"),
    categoryId,
    name,
    iconName: optionalStr(req.body, "iconName") || "Wrench",
    active: bool(req.body, "active", true),
  });

  await audit(actorOf(req), "catalog.subcategory.created", {
    subject: doc._id,
    detail: { name, categoryId },
  });

  res.status(201).json({
    id: doc._id,
    categoryId,
    categoryName: parent.name,
    name: doc.name,
    iconName: doc.iconName,
    active: doc.active,
  });
});

adminCatalogRouter.patch("/sub-categories/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await SubCategory.findById(id).lean();
  if (!existing) throw notFound("That sub-category no longer exists.");

  const patch: Record<string, unknown> = {};
  const name = optionalStr(req.body, "name");
  if (name) patch["name"] = name;
  const iconName = optionalStr(req.body, "iconName");
  if (iconName) patch["iconName"] = iconName;
  if (typeof (req.body as { active?: unknown })?.active === "boolean") {
    patch["active"] = (req.body as { active: boolean }).active;
  }

  const categoryId = optionalStr(req.body, "categoryId");
  if (categoryId && categoryId !== existing.categoryId) {
    const parent = await Category.findById(categoryId).lean();
    if (!parent) throw badRequest("That parent category does not exist.", "BAD_PARENT");
    patch["categoryId"] = categoryId;
  }

  await SubCategory.updateOne({ _id: id }, { $set: patch });
  await audit(actorOf(req), "catalog.subcategory.updated", {
    subject: id,
    detail: { patch },
  });

  const all = await listSubCategories();
  const updated = all.find((s) => s.id === id);
  if (!updated) throw notFound("That sub-category no longer exists.");
  res.json(updated);
});

adminCatalogRouter.delete("/sub-categories/:id", async (req, res) => {
  const { id } = req.params;
  const services = await Service.countDocuments({ subCategoryId: id });
  if (services > 0) {
    throw conflict(
      `That sub-category still has ${services} service${services === 1 ? "" : "s"}. ` +
        "Move or remove them first, or switch it off to hide it.",
      "NOT_EMPTY",
    );
  }

  const deleted = await SubCategory.findByIdAndDelete(id).lean();
  if (!deleted) throw notFound("That sub-category no longer exists.");

  await audit(actorOf(req), "catalog.subcategory.deleted", {
    subject: id,
    detail: { name: deleted.name },
  });
  res.status(204).end();
});

// -- Services (Admin 26, 27) --------------------------------------------------

adminCatalogRouter.get("/services", async (req, res) => {
  const search = typeof req.query["search"] === "string" ? req.query["search"] : undefined;
  res.json(await listServices({ search }));
});

adminCatalogRouter.get("/services/:id", async (req, res) => {
  const service = await findService(req.params.id);
  if (!service) throw notFound("That service no longer exists.");
  res.json(service);
});

/**
 * Reads the variant list off a request.
 *
 * **Exactly one variant is the default.** `ServiceVariant` says so, and the
 * customer's booking screen pre-selects it — with none, nothing is selected and
 * the customer sees an empty price; with two, which one wins depends on array
 * order. Normalised here rather than trusted, because the admin UI maintains
 * this invariant and a direct API caller has no reason to.
 */
function readVariants(body: unknown): ServiceDoc["variants"] {
  const raw = (body as { variants?: unknown })?.variants;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest("Variants must be a list.", "BAD_VARIANTS");

  const variants = raw.map((entry, i) => {
    const name = str(entry, "name", `Variant ${i + 1} name`);
    const e = entry as Record<string, unknown>;
    return {
      id: typeof e["id"] === "string" && e["id"] !== "" ? e["id"] : newId("var"),
      name,
      priceDeltaPaise: paise(entry, "priceDeltaPaise", {
        fallback: 0,
        // A variant can be cheaper than the base — "1 ton" under a 2-ton base.
        allowNegative: true,
      }),
      durationMinutes: Math.max(0, paise(entry, "durationMinutes", { fallback: 60 })),
      isDefault: Boolean(e["isDefault"]),
      active: e["active"] === undefined ? true : Boolean(e["active"]),
    };
  });

  if (variants.length === 0) return variants;

  const defaults = variants.filter((v) => v.isDefault);
  if (defaults.length === 1) return variants;

  // None or several: the first active one takes it, falling back to the first.
  const chosen = defaults[0] ?? variants.find((v) => v.active) ?? variants[0];
  return variants.map((v) => ({ ...v, isDefault: v.id === chosen?.id }));
}

adminCatalogRouter.post("/services", async (req, res) => {
  const name = str(req.body, "name", "Name");
  const subCategoryId = str(req.body, "subCategoryId", "Sub-category");

  // Same gate as the update path: creating a service at a price is still
  // setting a price.
  const pricingFields = ["basePricePaise", "platformFeePaise", "visitChargePaise", "nightSurchargePaise"];
  const setsPricing = pricingFields.some(
    (f) => (req.body as Record<string, unknown> | undefined)?.[f] !== undefined,
  );
  if (setsPricing && !can(actorOf(req), "services.edit_pricing")) {
    throw forbidden("You cannot set prices.");
  }

  const sub = await SubCategory.findById(subCategoryId).lean();
  if (!sub) throw badRequest("That sub-category does not exist.", "BAD_PARENT");

  const images = (req.body as { imagePaths?: unknown })?.imagePaths;

  const doc = await Service.create({
    _id: newId("svc"),
    subCategoryId,
    name,
    description: optionalStr(req.body, "description") ?? "",
    imagePaths: Array.isArray(images) ? images.filter((i): i is string => typeof i === "string") : [],
    inclusions: readInclusions(req.body),
    warrantyDays: paise(req.body, "warrantyDays", { fallback: 30 }),
    active: bool(req.body, "active", true),
    variants: readVariants(req.body),
    addOns: readAddOns(req.body),
    basePricePaise: paise(req.body, "basePricePaise", { fallback: 0 }),
    platformFeePaise: paise(req.body, "platformFeePaise", { fallback: 0 }),
    visitChargePaise: paise(req.body, "visitChargePaise", { fallback: 0 }),
    nightSurchargePaise: paise(req.body, "nightSurchargePaise", { fallback: 0 }),
  });

  await audit(actorOf(req), "catalog.service.created", {
    subject: doc._id,
    detail: { name, subCategoryId },
  });

  const created = await findService(doc._id);
  res.status(201).json(created);
});

/**
 * Reads the add-on list. Admin 27, Customer 14.
 *
 * Unlike a variant, an add-on is **additive and priced absolutely** — a
 * customer picks any number of them, or none, and each is separate work rather
 * than a different shape of the same job. So there is no default here, and no
 * normalisation: an empty list is a perfectly ordinary service.
 *
 * `CONSUMER-OPEN-ITEMS.md` 7.15 recorded the gap this closes: `priceBooking`
 * already takes `addOnsPaise` and `createBooking` takes `addOnIds`, but there
 * was no way for an admin to create one — so the customer side was priced
 * against data nobody could enter.
 */
function readAddOns(body: unknown): ServiceDoc["addOns"] {
  const raw = (body as { addOns?: unknown })?.addOns;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest("Add-ons must be a list.", "BAD_ADDONS");

  return raw.map((entry, i) => {
    const name = str(entry, "name", `Add-on ${i + 1} name`);
    const e = entry as Record<string, unknown>;
    return {
      id: typeof e["id"] === "string" && e["id"] !== "" ? e["id"] : newId("add"),
      name,
      description: optionalStr(entry, "description") ?? "",
      pricePaise: paise(entry, "pricePaise", { fallback: 0 }),
      durationMinutes: Math.max(0, paise(entry, "durationMinutes", { fallback: 0 })),
      active: e["active"] === undefined ? true : Boolean(e["active"]),
    };
  });
}

function readInclusions(body: unknown): string[] {
  const raw = (body as { inclusions?: unknown })?.inclusions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is string => typeof i === "string")
    .map((i) => i.trim())
    .filter((i) => i !== "");
}

adminCatalogRouter.patch("/services/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await Service.findById(id).lean<ServiceDoc>();
  if (!existing) throw notFound("That service no longer exists.");

  const patch: Record<string, unknown> = {};
  const name = optionalStr(req.body, "name");
  if (name) patch["name"] = name;
  const description = optionalStr(req.body, "description");
  if (description !== undefined) patch["description"] = description;
  if (typeof (req.body as { active?: unknown })?.active === "boolean") {
    patch["active"] = (req.body as { active: boolean }).active;
  }
  if ((req.body as { inclusions?: unknown })?.inclusions !== undefined) {
    patch["inclusions"] = readInclusions(req.body);
  }
  if ((req.body as { warrantyDays?: unknown })?.warrantyDays !== undefined) {
    patch["warrantyDays"] = paise(req.body, "warrantyDays");
  }
  if ((req.body as { variants?: unknown })?.variants !== undefined) {
    patch["variants"] = readVariants(req.body);
  }
  if ((req.body as { addOns?: unknown })?.addOns !== undefined) {
    patch["addOns"] = readAddOns(req.body);
  }

  /**
   * The base price is editable from the service dialog as well as the Pricing
   * tab, but it is **the same permission either way**. Letting it through here
   * ungated would make this route a way around `services.edit_pricing` — the
   * gate would read as enforced while a second door stood open beside it.
   */
  if ((req.body as { basePricePaise?: unknown })?.basePricePaise !== undefined) {
    if (!can(actorOf(req), "services.edit_pricing")) {
      throw forbidden("You cannot change prices.");
    }
    patch["basePricePaise"] = paise(req.body, "basePricePaise");
  }
  const images = (req.body as { imagePaths?: unknown })?.imagePaths;
  if (Array.isArray(images)) {
    patch["imagePaths"] = images.filter((i): i is string => typeof i === "string");
  }

  const subCategoryId = optionalStr(req.body, "subCategoryId");
  if (subCategoryId && subCategoryId !== existing.subCategoryId) {
    const sub = await SubCategory.findById(subCategoryId).lean();
    if (!sub) throw badRequest("That sub-category does not exist.", "BAD_PARENT");
    patch["subCategoryId"] = subCategoryId;
  }

  await Service.updateOne({ _id: id }, { $set: patch });
  await audit(actorOf(req), "catalog.service.updated", {
    subject: id,
    detail: { patch },
  });

  res.json(await findService(id));
});

adminCatalogRouter.delete("/services/:id", async (req, res) => {
  const deleted = await Service.findByIdAndDelete(req.params.id).lean<ServiceDoc>();
  if (!deleted) throw notFound("That service no longer exists.");

  await audit(actorOf(req), "catalog.service.deleted", {
    subject: req.params.id,
    detail: { name: deleted.name },
  });
  res.status(204).end();
});

// -- Pricing (Admin 28) -------------------------------------------------------

adminCatalogRouter.get("/pricing", async (_req, res) => {
  res.json(await listPricingRules());
});

/**
 * Admin 28 — base price, platform fee, visit charge, night surcharge, and the
 * optional city override.
 *
 * Gated on `services.edit_pricing`: this changes what a customer pays, which is
 * a Super Admin decision in the agreement, not a delegated one.
 *
 * **GST is not set here.** CGST 9% + SGST 9% are computed from the platform fee
 * at booking time (`CGST_BPS` in `@cfc/types`) and never stored per service —
 * a per-service tax rate is how a tax rate ends up wrong on one row.
 */
adminCatalogRouter.patch(
  "/pricing/:serviceId",
  requirePermission("services.edit_pricing"),
  async (req, res) => {
    const serviceId = param(req, "serviceId");
    const existing = await Service.findById(serviceId).lean<ServiceDoc>();
    if (!existing) throw notFound("That service no longer exists.");

    const patch: Record<string, unknown> = {
      basePricePaise: paise(req.body, "basePricePaise", {
        fallback: existing.basePricePaise,
      }),
      platformFeePaise: paise(req.body, "platformFeePaise", {
        fallback: existing.platformFeePaise,
      }),
      visitChargePaise: paise(req.body, "visitChargePaise", {
        fallback: existing.visitChargePaise,
      }),
      nightSurchargePaise: paise(req.body, "nightSurchargePaise", {
        fallback: existing.nightSurchargePaise,
      }),
    };

    const override = (req.body as { cityOverride?: unknown })?.cityOverride;
    if (override === null) {
      patch["cityOverride"] = undefined;
    } else if (override !== undefined) {
      const city = str(override, "city", "Override city");
      patch["cityOverride"] = {
        city,
        basePricePaise: paise(override, "basePricePaise"),
      };
    }

    await Service.updateOne(
      { _id: serviceId },
      override === null
        ? { $set: patch, $unset: { cityOverride: "" } }
        : { $set: patch },
    );

    // Price changes are the ones most often queried later, so both the old and
    // the new figures are recorded rather than just the new.
    await audit(actorOf(req), "catalog.pricing.updated", {
      subject: serviceId,
      detail: {
        service: existing.name,
        before: {
          basePricePaise: existing.basePricePaise,
          platformFeePaise: existing.platformFeePaise,
          visitChargePaise: existing.visitChargePaise,
          nightSurchargePaise: existing.nightSurchargePaise,
        },
        after: patch,
      },
    });

    const rules = await listPricingRules();
    res.json(rules.find((r) => r.serviceId === serviceId));
  },
);

// -- Commission (Admin 29) ----------------------------------------------------

adminCatalogRouter.get("/commission", async (_req, res) => {
  res.json(await listCommissionRules());
});

adminCatalogRouter.put(
  "/commission",
  requirePermission("services.edit_commission"),
  async (req, res) => {
    const scope = str(req.body, "scope", "Scope");
    if (scope !== "category" && scope !== "pro" && scope !== "partner") {
      throw badRequest("Scope must be category, pro or partner.", "BAD_SCOPE");
    }
    const targetId = str(req.body, "targetId", "Target");
    const commissionBps = paise(req.body, "commissionBps");

    // 10,000 bps is 100%. Beyond that the pro owes money for working, which is
    // a typo (150 meaning 15% entered as 15000) rather than a rate.
    if (commissionBps > 10_000) {
      throw badRequest(
        "Commission cannot exceed 100% (10000 basis points).",
        "BAD_RATE",
      );
    }

    const note = optionalStr(req.body, "note");
    await CommissionRule.findOneAndUpdate(
      { scope, targetId },
      {
        $set: { commissionBps, ...(note !== undefined ? { note } : {}) },
        $setOnInsert: { _id: newId("com") },
      },
      { upsert: true, new: true },
    );

    await audit(actorOf(req), "catalog.commission.updated", {
      subject: `${scope}:${targetId}`,
      detail: { commissionBps },
    });

    res.json(await listCommissionRules());
  },
);

// -- Image upload -------------------------------------------------------------

/**
 * Uploads one image and returns the path to store.
 *
 * The file is written first and **verified after** — multer streams to disk, so
 * the magic-byte check cannot happen earlier. A file that fails is deleted
 * before responding, so a rejected upload leaves nothing behind.
 */
adminCatalogRouter.post("/images", imageUpload.single("file"), async (req, res) => {
  const { file } = req;
  if (!file) throw badRequest("No file was uploaded.", "NO_FILE");

  const ok = await verifyImageBytes(file.path);
  if (!ok) {
    await fs.unlink(file.path).catch(() => {
      /* already gone, or never written */
    });
    throw badRequest(
      "That file is not a valid image. JPG, PNG and WebP are supported.",
      "BAD_FILE_TYPE",
    );
  }

  const storedPath = publicPathFor(path.basename(file.path));
  await audit(actorOf(req), "catalog.image.uploaded", {
    detail: { path: storedPath, bytes: file.size },
  });

  res.status(201).json({ path: storedPath, url: storedPath });
});
