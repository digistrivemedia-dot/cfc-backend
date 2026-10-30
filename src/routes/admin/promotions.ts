import { Router } from "express";
import type { Banner as TypedBanner, Coupon as TypedCoupon, SubAdmin } from "@cfc/types";
import { ADMIN_SECTIONS, type AdminSection } from "@cfc/types";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
} from "../../middleware/auth";
import { Coupon, type CouponDoc } from "../../models/coupon";
import { Banner, type BannerDoc } from "../../models/banner";
import { AdminUser, type AdminUserDoc } from "../../models/admin-user";
import { Service } from "../../models/catalog";
import { hashPassword } from "../../auth/password";
import { audit } from "../../models/audit";
import { newId } from "../../models/id";
import { param } from "../../params";
import { PUBLIC_PREFIX } from "../../uploads";

/**
 * Admin 35–37 — coupons and banners. Admin 49 — sub admins.
 *
 * Grouped because they are the three places an operator *creates* something
 * that is neither catalogue nor money, and they share nothing else.
 */
export const adminPromotionsRouter = Router();
export const adminUsersRouter = Router();

adminPromotionsRouter.use(requireAuth, requireSection("promotions"));
adminUsersRouter.use(requireAuth, requireSection("settings"));

// -- Coupons (Admin 35, 36) ---------------------------------------------------

/**
 * The model stores `serviceIds`; the screens speak `serviceNames`.
 *
 * Resolved on read rather than storing names: a service rename must not
 * silently widen a coupon to a service it was never meant to cover, which is
 * what matching on a stale name string would do.
 */
async function toCoupon(
  doc: CouponDoc,
  names: Map<string, string>,
): Promise<TypedCoupon> {
  return {
    id: doc._id,
    code: doc.code,
    discountType: doc.discountType,
    discountValue: doc.discountValue,
    maxUses: doc.maxUses,
    usedCount: doc.usedCount,
    expiresAt: doc.expiresAt.toISOString(),
    firstBookingOnly: doc.firstBookingOnly,
    restrictions: {
      areas: doc.restrictions.areas,
      serviceNames: doc.restrictions.serviceIds.map((id) => names.get(id) ?? id),
      minOrderPaise: doc.restrictions.minOrderPaise,
      maxDiscountPaise: doc.restrictions.maxDiscountPaise,
      perCustomerLimit: doc.restrictions.perCustomerLimit,
    },
    active: doc.active,
  };
}

async function serviceNameMap(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const docs = await Service.find({ _id: { $in: [...new Set(ids)] } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();
  return new Map(docs.map((d) => [d._id, d.name]));
}

adminPromotionsRouter.get("/coupons", async (_req, res) => {
  const docs = await Coupon.find({}).sort({ createdAt: -1 }).lean<CouponDoc[]>();
  const names = await serviceNameMap(docs.flatMap((d) => d.restrictions.serviceIds));
  res.json(await Promise.all(docs.map((d) => toCoupon(d, names))));
});

/** Validates the shape both create and update share. */
function readCouponInput(body: unknown): {
  code: string;
  discountType: "percent" | "flat";
  discountValue: number;
  maxUses: number;
  expiresAt: Date;
  firstBookingOnly: boolean;
  restrictions: CouponDoc["restrictions"];
  active: boolean;
} {
  const b = (body ?? {}) as Record<string, unknown>;

  const code = typeof b["code"] === "string" ? b["code"].trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{3,20}$/.test(code)) {
    throw badRequest(
      "A code is 3 to 20 letters and digits.",
      "BAD_CODE",
    );
  }

  const discountType = b["discountType"];
  if (discountType !== "percent" && discountType !== "flat") {
    throw badRequest("A discount is percent or flat.", "BAD_TYPE");
  }

  const discountValue = b["discountValue"];
  if (typeof discountValue !== "number" || discountValue <= 0) {
    throw badRequest("A discount must be more than zero.", "BAD_VALUE");
  }
  // A 120% discount would pay the customer to book.
  if (discountType === "percent" && discountValue > 100) {
    throw badRequest("A percentage discount cannot exceed 100.", "BAD_VALUE");
  }

  const expiresRaw = b["expiresAt"];
  const expiresAt =
    typeof expiresRaw === "string" ? new Date(expiresRaw) : new Date(NaN);
  if (Number.isNaN(expiresAt.getTime())) {
    throw badRequest("An expiry date is required.", "BAD_EXPIRY");
  }

  const r = (b["restrictions"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    code,
    discountType,
    discountValue,
    maxUses: num(b["maxUses"]),
    expiresAt,
    firstBookingOnly: b["firstBookingOnly"] === true,
    restrictions: {
      areas: list(r["areas"]),
      serviceIds: list(r["serviceIds"]),
      minOrderPaise: num(r["minOrderPaise"]),
      maxDiscountPaise: num(r["maxDiscountPaise"]),
      perCustomerLimit: num(r["perCustomerLimit"]),
    },
    active: b["active"] !== false,
  };
}

adminPromotionsRouter.post("/coupons", async (req, res) => {
  const input = readCouponInput(req.body);

  const clash = await Coupon.findOne({ code: input.code }).lean();
  if (clash) {
    throw conflict("A coupon with that code already exists.", "DUPLICATE_CODE");
  }

  const doc = await Coupon.create({ _id: newId("cpn"), ...input, usedCount: 0 });
  await audit(actorOf(req), "coupon.created", {
    subject: doc._id,
    detail: { code: input.code },
  });

  const names = await serviceNameMap(input.restrictions.serviceIds);
  res.status(201).json(await toCoupon(doc.toObject() as CouponDoc, names));
});

adminPromotionsRouter.patch("/coupons/:id", async (req, res) => {
  const id = param(req, "id");
  const input = readCouponInput(req.body);

  const clash = await Coupon.findOne({ code: input.code, _id: { $ne: id } }).lean();
  if (clash) {
    throw conflict("A coupon with that code already exists.", "DUPLICATE_CODE");
  }

  // `usedCount` is deliberately not in the update: redemptions are the
  // coupon's history, and an edit must never reset them. A coupon that has
  // been used 400 times cannot be made fresh by saving the form.
  const doc = await Coupon.findOneAndUpdate(
    { _id: id },
    { $set: input },
    { new: true },
  ).lean<CouponDoc>();
  if (!doc) throw notFound("Coupon not found.");

  await audit(actorOf(req), "coupon.updated", { subject: id, detail: { code: input.code } });

  const names = await serviceNameMap(doc.restrictions.serviceIds);
  res.json(await toCoupon(doc, names));
});

/**
 * Switched off rather than deleted.
 *
 * A coupon that has been redeemed is referenced by the bookings that used it;
 * deleting it would orphan their discount line.
 */
adminPromotionsRouter.post("/coupons/:id/toggle", async (req, res) => {
  const id = param(req, "id");
  const doc = await Coupon.findById(id).lean<CouponDoc>();
  if (!doc) throw notFound("Coupon not found.");

  const next = !doc.active;
  await Coupon.updateOne({ _id: id }, { $set: { active: next } });
  await audit(actorOf(req), next ? "coupon.enabled" : "coupon.disabled", {
    subject: id,
  });
  res.json({ id, active: next });
});

// -- Banners (Admin 37) -------------------------------------------------------

function toBanner(doc: BannerDoc): TypedBanner {
  return {
    id: doc._id,
    // A relative path, so moving host does not need a migration (§0.4).
    imageUrl: `${PUBLIC_PREFIX}/${doc.imagePath}`.replace(/\/{2,}/g, "/"),
    title: doc.title,
    linkType: doc.linkType,
    linkTarget: doc.linkTarget,
    sortOrder: doc.sortOrder,
    active: doc.active,
    scheduledFrom: doc.scheduledFrom?.toISOString() ?? null,
    scheduledTo: doc.scheduledTo?.toISOString() ?? null,
  };
}

adminPromotionsRouter.get("/banners", async (_req, res) => {
  const docs = await Banner.find({}).sort({ sortOrder: 1 }).lean<BannerDoc[]>();
  res.json(docs.map(toBanner));
});

function readBannerInput(body: unknown): Omit<BannerDoc, "_id" | "createdAt" | "updatedAt"> {
  const b = (body ?? {}) as Record<string, unknown>;

  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (title === "") throw badRequest("A title is required.", "MISSING_FIELD");

  const imagePath = typeof b["imagePath"] === "string" ? b["imagePath"].trim() : "";
  if (imagePath === "") throw badRequest("An image is required.", "MISSING_IMAGE");

  const linkType = b["linkType"];
  if (linkType !== "category" && linkType !== "service" && linkType !== "none") {
    throw badRequest("A banner links to a category, a service, or nothing.", "BAD_LINK");
  }
  const linkTarget =
    typeof b["linkTarget"] === "string" && b["linkTarget"].trim() !== ""
      ? b["linkTarget"].trim()
      : null;
  if (linkType !== "none" && linkTarget === null) {
    // A banner that says it links somewhere and does not is a dead tap.
    throw badRequest("Choose what the banner links to.", "MISSING_TARGET");
  }

  const date = (v: unknown): Date | null => {
    if (typeof v !== "string" || v.trim() === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw badRequest("Invalid date.", "BAD_DATE");
    return d;
  };
  const scheduledFrom = date(b["scheduledFrom"]);
  const scheduledTo = date(b["scheduledTo"]);
  if (scheduledFrom && scheduledTo && scheduledTo < scheduledFrom) {
    throw badRequest("The banner would end before it starts.", "BAD_WINDOW");
  }

  return {
    imagePath,
    title,
    linkType,
    linkTarget,
    sortOrder: typeof b["sortOrder"] === "number" ? b["sortOrder"] : 0,
    active: b["active"] !== false,
    scheduledFrom,
    scheduledTo,
  };
}

adminPromotionsRouter.post("/banners", async (req, res) => {
  const doc = await Banner.create({ _id: newId("bnr"), ...readBannerInput(req.body) });
  await audit(actorOf(req), "banner.created", { subject: doc._id });
  res.status(201).json(toBanner(doc.toObject() as BannerDoc));
});

adminPromotionsRouter.patch("/banners/:id", async (req, res) => {
  const id = param(req, "id");
  const doc = await Banner.findOneAndUpdate(
    { _id: id },
    { $set: readBannerInput(req.body) },
    { new: true },
  ).lean<BannerDoc>();
  if (!doc) throw notFound("Banner not found.");
  await audit(actorOf(req), "banner.updated", { subject: id });
  res.json(toBanner(doc));
});

adminPromotionsRouter.delete("/banners/:id", async (req, res) => {
  const id = param(req, "id");
  // Banners carry no history worth keeping — nothing references one — so this
  // is a real delete, unlike a coupon.
  const result = await Banner.deleteOne({ _id: id });
  if (result.deletedCount === 0) throw notFound("Banner not found.");
  await audit(actorOf(req), "banner.deleted", { subject: id });
  res.json({ ok: true });
});

// -- Sub admins (Admin 49) ----------------------------------------------------

function toSubAdmin(doc: AdminUserDoc): SubAdmin {
  return {
    id: doc._id,
    name: doc.name,
    role: doc.role,
    ...(doc.area !== undefined ? { area: doc.area } : {}),
    sections: doc.sections,
    active: doc.active,
  };
}

adminUsersRouter.get("/", async (_req, res) => {
  const docs = await AdminUser.find({}).sort({ createdAt: 1 }).lean<AdminUserDoc[]>();
  res.json(docs.map(toSubAdmin));
});

/**
 * Admin 49 — create a delegated admin.
 *
 * Gated on `settings.manage_admins`, which only a super admin holds. The
 * sections requested are stored as asked, and `canOpen` in `@cfc/types`
 * **intersects them with the role's own list** on every check — so a row here
 * can narrow a role but never widen it, and granting "settings" to a sub admin
 * silently grants nothing. That is deliberate: the enforcement lives in one
 * shared function rather than in validation that could be bypassed by an
 * endpoint someone adds later.
 */
adminUsersRouter.post("/", requirePermission("settings.manage_admins"), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;

  const name = typeof b["name"] === "string" ? b["name"].trim() : "";
  const email = typeof b["email"] === "string" ? b["email"].trim().toLowerCase() : "";
  const password = typeof b["password"] === "string" ? b["password"] : "";
  const role = b["role"];

  if (name === "") throw badRequest("A name is required.", "MISSING_FIELD");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw badRequest("A valid email is required.", "BAD_EMAIL");
  }
  if (password.length < 10) {
    throw badRequest("A password must be at least 10 characters.", "WEAK_PASSWORD");
  }
  if (role !== "sub_admin" && role !== "area_admin") {
    throw badRequest("A delegated admin is a sub admin or an area admin.", "BAD_ROLE");
  }

  const area = typeof b["area"] === "string" ? b["area"].trim() : "";
  if (role === "area_admin" && area === "") {
    // An area admin with no area is scoped to nothing and sees nothing.
    throw badRequest("An area admin needs an area.", "MISSING_AREA");
  }

  const sections = Array.isArray(b["sections"])
    ? (b["sections"] as unknown[]).filter((x): x is AdminSection =>
        typeof x === "string" && (ADMIN_SECTIONS as readonly string[]).includes(x),
      )
    : [];
  if (sections.length === 0) {
    throw badRequest("Choose at least one section.", "NO_SECTIONS");
  }

  const clash = await AdminUser.findOne({ email }).lean();
  if (clash) throw conflict("An admin with that email already exists.", "DUPLICATE");

  const doc = await AdminUser.create({
    _id: newId("adm"),
    email,
    passwordHash: await hashPassword(password),
    name,
    role,
    ...(role === "area_admin" ? { area } : {}),
    sections,
    active: true,
  });

  // The password is never echoed, logged, or included in the audit detail.
  await audit(actorOf(req), "admin.created", {
    subject: doc._id,
    detail: { email, role, sections },
  });

  res.status(201).json(toSubAdmin(doc.toObject() as AdminUserDoc));
});

adminUsersRouter.patch(
  "/:id",
  requirePermission("settings.manage_admins"),
  async (req, res) => {
    const id = param(req, "id");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    if (typeof b["name"] === "string" && b["name"].trim() !== "") {
      update["name"] = b["name"].trim();
    }
    if (Array.isArray(b["sections"])) {
      const sections = (b["sections"] as unknown[]).filter((x): x is AdminSection =>
        typeof x === "string" && (ADMIN_SECTIONS as readonly string[]).includes(x),
      );
      if (sections.length === 0) {
        throw badRequest("Choose at least one section.", "NO_SECTIONS");
      }
      update["sections"] = sections;
    }
    if (typeof b["area"] === "string") update["area"] = b["area"].trim();

    if (Object.keys(update).length === 0) {
      throw badRequest("Nothing to change.", "NO_CHANGE");
    }

    const doc = await AdminUser.findOneAndUpdate(
      { _id: id },
      { $set: update },
      { new: true },
    ).lean<AdminUserDoc>();
    if (!doc) throw notFound("Admin not found.");

    await audit(actorOf(req), "admin.updated", { subject: id, detail: update });
    res.json(toSubAdmin(doc));
  },
);

/**
 * Admin 49 — revoke, not delete.
 *
 * The record stays so the audit log's `actor` still resolves to a person. An
 * admin who approved forty KYC submissions and was then deleted would leave
 * forty audit rows attributed to an id that means nothing.
 */
adminUsersRouter.post(
  "/:id/revoke",
  requirePermission("settings.manage_admins"),
  async (req, res) => {
    const id = param(req, "id");
    const actor = actorOf(req);
    if (id === actor.id) {
      throw conflict("You cannot revoke your own access.", "SELF_REVOKE");
    }

    const doc = await AdminUser.findOneAndUpdate(
      { _id: id },
      { $set: { active: false } },
      { new: true },
    ).lean<AdminUserDoc>();
    if (!doc) throw notFound("Admin not found.");

    await audit(actor, "admin.revoked", { subject: id });
    res.json(toSubAdmin(doc));
  },
);

adminUsersRouter.post(
  "/:id/restore",
  requirePermission("settings.manage_admins"),
  async (req, res) => {
    const id = param(req, "id");
    const doc = await AdminUser.findOneAndUpdate(
      { _id: id },
      { $set: { active: true } },
      { new: true },
    ).lean<AdminUserDoc>();
    if (!doc) throw notFound("Admin not found.");

    await audit(actorOf(req), "admin.restored", { subject: id });
    res.json(toSubAdmin(doc));
  },
);
