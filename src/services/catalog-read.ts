import type {
  Category,
  CommissionRule,
  PricingRule,
  ServiceDetail,
  SubCategory,
} from "@cfc/types";
import {
  Category as CategoryModel,
  CommissionRule as CommissionRuleModel,
  Service as ServiceModel,
  SubCategory as SubCategoryModel,
  type CategoryDoc,
  type ServiceDoc,
  type SubCategoryDoc,
} from "../models/catalog";
import { Booking as BookingModel } from "../models/booking";
import { ratingsBy } from "../models/review";
import { PUBLIC_PREFIX } from "../uploads";

/**
 * Reading the catalogue, projected into `@cfc/types` shapes.
 *
 * One module for every read, shared by the public and admin routers, because
 * the alternative is two projections of the same document that disagree about
 * one field. The admin's service list and the customer's service list differ in
 * *which rows* they include, never in what a row looks like.
 *
 * The denormalised display names (`categoryName`, `subCategoryName`) are
 * resolved here rather than stored — see the note in `models/catalog.ts`.
 */

/** Stored paths are relative; a URL for the browser is the same path. */
function toUrl(storedPath: string): string {
  // Already absolute (an externally hosted image) — leave it alone.
  if (/^https?:\/\//.test(storedPath)) return storedPath;
  return storedPath.startsWith(PUBLIC_PREFIX)
    ? storedPath
    : `${PUBLIC_PREFIX}/${storedPath.replace(/^\/+/, "")}`;
}

/**
 * How many services sit under each category, keyed by category id.
 *
 * One aggregation rather than a count per category: a catalogue of 50+ services
 * across a dozen categories would otherwise be a dozen round trips every time
 * the category list is opened, which is constantly.
 */
async function serviceCounts(): Promise<Map<string, number>> {
  const rows = await ServiceModel.aggregate<{ _id: string; n: number }>([
    {
      $lookup: {
        from: SubCategoryModel.collection.name,
        localField: "subCategoryId",
        foreignField: "_id",
        as: "sub",
      },
    },
    { $unwind: "$sub" },
    { $group: { _id: "$sub.categoryId", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export function toCategory(doc: CategoryDoc, serviceCount: number): Category {
  return {
    id: doc._id,
    name: doc.name,
    iconName: doc.iconName,
    description: doc.description,
    sortOrder: doc.sortOrder,
    active: doc.active,
    serviceCount,
  };
}

/**
 * Every category, in `sortOrder`.
 *
 * `activeOnly` is what separates the customer's view from the admin's: a
 * customer must never see a category an admin has switched off, and the admin
 * must still see it to switch it back on.
 */
export async function listCategories(
  options: { activeOnly?: boolean } = {},
): Promise<Category[]> {
  const filter = options.activeOnly ? { active: true } : {};
  const [docs, counts] = await Promise.all([
    CategoryModel.find(filter).sort({ sortOrder: 1 }).lean<CategoryDoc[]>(),
    serviceCounts(),
  ]);
  return docs.map((d) => toCategory(d, counts.get(d._id) ?? 0));
}

export function toSubCategory(
  doc: SubCategoryDoc,
  categoryName: string,
): SubCategory {
  return {
    id: doc._id,
    categoryId: doc.categoryId,
    categoryName,
    name: doc.name,
    iconName: doc.iconName,
    active: doc.active,
  };
}

export async function listSubCategories(
  options: { categoryId?: string; activeOnly?: boolean } = {},
): Promise<SubCategory[]> {
  const filter: Record<string, unknown> = {};
  if (options.categoryId) filter["categoryId"] = options.categoryId;
  if (options.activeOnly) filter["active"] = true;

  const docs = await SubCategoryModel.find(filter)
    .sort({ name: 1 })
    .lean<SubCategoryDoc[]>();

  const names = await categoryNames(docs.map((d) => d.categoryId));
  return docs.map((d) => toSubCategory(d, names.get(d.categoryId) ?? ""));
}

async function categoryNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const docs = await CategoryModel.find({ _id: { $in: [...new Set(ids)] } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();
  return new Map(docs.map((d) => [d._id, d.name]));
}

/**
 * A service, projected as `ServiceDetail`.
 *
 * `bookingCount`, `rating` and `reviewCount` are **zero until the phases that
 * create them** — bookings in Phase 5, reviews in Phase 9. They are reported as
 * real zeroes rather than omitted: `ServiceListItem` documents that zero
 * reviews renders as "New", which is the truthful thing to show for a service
 * nobody has booked yet.
 */
export function toServiceDetail(
  doc: ServiceDoc,
  categoryName: string,
  subCategoryName: string,
  stats: { bookingCount: number; rating: number; reviewCount: number } = {
    bookingCount: 0,
    rating: 0,
    reviewCount: 0,
  },
): ServiceDetail {
  return {
    id: doc._id,
    name: doc.name,
    categoryName,
    subCategoryName,
    basePricePaise: doc.basePricePaise,
    active: doc.active,
    bookingCount: stats.bookingCount,
    rating: stats.rating,
    reviewCount: stats.reviewCount,
    description: doc.description,
    imageUrls: doc.imagePaths.map(toUrl),
    variants: doc.variants.map((v) => ({
      id: v.id,
      name: v.name,
      priceDeltaPaise: v.priceDeltaPaise,
      durationMinutes: v.durationMinutes,
      isDefault: v.isDefault,
      active: v.active,
    })),
    addOns: doc.addOns.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      pricePaise: a.pricePaise,
      durationMinutes: a.durationMinutes,
      active: a.active,
    })),
    inclusions: doc.inclusions,
    warrantyDays: doc.warrantyDays,
  };
}

/** Resolves sub-category and category names for a batch of services. */
async function serviceNames(
  docs: ServiceDoc[],
): Promise<Map<string, { sub: string; category: string }>> {
  if (docs.length === 0) return new Map();

  const subs = await SubCategoryModel.find({
    _id: { $in: [...new Set(docs.map((d) => d.subCategoryId))] },
  })
    .select({ name: 1, categoryId: 1 })
    .lean<{ _id: string; name: string; categoryId: string }[]>();

  const catNames = await categoryNames(subs.map((s) => s.categoryId));
  const bySub = new Map(
    subs.map((s) => [
      s._id,
      { sub: s.name, category: catNames.get(s.categoryId) ?? "" },
    ]),
  );

  return new Map(
    docs.map((d) => [
      d._id,
      bySub.get(d.subCategoryId) ?? { sub: "", category: "" },
    ]),
  );
}

export const EMPTY_STATS = { bookingCount: 0, rating: 0, reviewCount: 0 };

/**
 * Real booking and review figures for a set of services.
 *
 * These were hardcoded zeroes with a note saying "until the phases that create
 * them" — bookings landed in Phase 5 and reviews in Phase 9, so both exist now
 * and the note was the only thing still holding them at zero.
 *
 * A cancelled booking does not count: "most booked" is a claim about work
 * people went through with, and counting abandoned ones inflates every figure
 * the home screen sorts by.
 */
export async function serviceStats(
  ids: string[],
): Promise<Map<string, { bookingCount: number; rating: number; reviewCount: number }>> {
  if (ids.length === 0) return new Map();

  const [bookings, ratings] = await Promise.all([
    BookingModel.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          serviceId: { $in: ids },
          status: { $ne: "cancelled" },
        },
      },
      { $group: { _id: "$serviceId", count: { $sum: 1 } } },
    ]),
    ratingsBy("serviceId", ids),
  ]);

  const byService = new Map(bookings.map((b) => [b._id, b.count]));

  return new Map(
    ids.map((id) => [
      id,
      {
        bookingCount: byService.get(id) ?? 0,
        rating: ratings.get(id)?.rating ?? 0,
        reviewCount: ratings.get(id)?.reviewCount ?? 0,
      },
    ]),
  );
}

export interface ServiceQuery {
  /** Free text. Uses the `service_search` text index when present. */
  search?: string | undefined;
  subCategoryId?: string | undefined;
  categoryId?: string | undefined;
  activeOnly?: boolean | undefined;
}

export async function listServices(
  query: ServiceQuery = {},
): Promise<ServiceDetail[]> {
  const filter: Record<string, unknown> = {};
  if (query.activeOnly) filter["active"] = true;
  if (query.subCategoryId) filter["subCategoryId"] = query.subCategoryId;

  // Filtering by category means resolving its sub-categories first — the
  // service does not carry a categoryId, by design.
  if (query.categoryId) {
    const subs = await SubCategoryModel.find({ categoryId: query.categoryId })
      .select({ _id: 1 })
      .lean<{ _id: string }[]>();
    filter["subCategoryId"] = { $in: subs.map((s) => s._id) };
  }

  if (query.search?.trim()) {
    // A regex rather than `$text` for the admin's type-ahead: `$text` matches
    // whole words only, so "clea" would find nothing while someone is still
    // typing "cleaning". Escaped, or a stray "(" from a search box is a crash.
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["name"] = { $regex: escaped, $options: "i" };
  }

  const docs = await ServiceModel.find(filter)
    .sort({ name: 1 })
    .lean<ServiceDoc[]>();
  const names = await serviceNames(docs);
  const stats = await serviceStats(docs.map((d) => d._id));

  return docs.map((d) => {
    const n = names.get(d._id);
    return toServiceDetail(
      d,
      n?.category ?? "",
      n?.sub ?? "",
      stats.get(d._id) ?? EMPTY_STATS,
    );
  });
}

export async function findService(id: string): Promise<ServiceDetail | null> {
  const doc = await ServiceModel.findById(id).lean<ServiceDoc>();
  if (!doc) return null;
  const [names, stats] = await Promise.all([
    serviceNames([doc]),
    serviceStats([doc._id]),
  ]);
  const n = names.get(doc._id);
  return toServiceDetail(
    doc,
    n?.category ?? "",
    n?.sub ?? "",
    stats.get(doc._id) ?? EMPTY_STATS,
  );
}

/**
 * Customer search — per-word, order and position free.
 *
 * Matches the service name, its category and its sub-category, so "cleaning"
 * finds everything under Cleaning rather than only the rows with the word in
 * their own name. A customer searching a category term and getting nothing is
 * the most common way search feels broken.
 *
 * Done in memory over the active catalogue rather than in the query, because
 * the haystack spans two joined collections — the category and sub-category
 * names are not on the service document. At ~50 services that is one scan of a
 * list the page was already fetching.
 *
 * `ponytail:` *in-memory AND over the catalogue. Denormalise the category and
 * sub-category names onto the service and push this into the query if the
 * catalogue reaches the thousands — it is tens today.*
 */
export async function searchCatalogue(query: string): Promise<ServiceDetail[]> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const all = await listServices({ activeOnly: true });
  return all.filter((s) => {
    const haystack =
      `${s.name} ${s.categoryName} ${s.subCategoryName}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

// -- Pricing and commission --------------------------------------------------

/**
 * Pricing rules, projected from the services themselves.
 *
 * There is no `PricingRule` collection — see `models/catalog.ts`. The type is
 * one-to-one with a service, so this is a projection, not a join.
 */
export async function listPricingRules(): Promise<PricingRule[]> {
  const docs = await ServiceModel.find().sort({ name: 1 }).lean<ServiceDoc[]>();
  return docs.map((d) => ({
    serviceId: d._id,
    serviceName: d.name,
    basePricePaise: d.basePricePaise,
    platformFeePaise: d.platformFeePaise,
    visitChargePaise: d.visitChargePaise,
    nightSurchargePaise: d.nightSurchargePaise,
    cityOverride: d.cityOverride
      ? { city: d.cityOverride.city, basePricePaise: d.cityOverride.basePricePaise }
      : undefined,
  }));
}

/**
 * Commission rules, with the target's display name resolved.
 *
 * Only `category` targets resolve today — pros and partners arrive in Phase 4,
 * and a rule pointing at a pro that does not exist yet shows its id rather than
 * a blank, so a stale rule is visible instead of looking like a loading bug.
 */
export async function listCommissionRules(): Promise<CommissionRule[]> {
  const docs = await CommissionRuleModel.find()
    .sort({ scope: 1 })
    .lean<CommissionRuleDocLean[]>();

  const categoryIds = docs.filter((d) => d.scope === "category").map((d) => d.targetId);
  const names = await categoryNames(categoryIds);

  return docs.map((d) => ({
    id: d._id,
    scope: d.scope,
    targetName:
      d.scope === "category" ? (names.get(d.targetId) ?? d.targetId) : d.targetId,
    commissionBps: d.commissionBps,
    note: d.note,
  }));
}

interface CommissionRuleDocLean {
  _id: string;
  scope: "category" | "pro" | "partner";
  targetId: string;
  commissionBps: number;
  note?: string;
}
