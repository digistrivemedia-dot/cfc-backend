import { Schema, model } from "mongoose";

/**
 * The service catalogue — Admin 22 to 29.
 *
 * *"All categories, sub-categories, services and pricing are created and
 * managed entirely by the Admin. **Nothing is hardcoded.**"*
 *
 * Two decisions shape these schemas.
 *
 * **Names are not stored twice.** `SubCategory` in `@cfc/types` carries a
 * `categoryName`, and `ServiceListItem` carries both `categoryName` and
 * `subCategoryName` — but those are *projections for rendering*, resolved on
 * read. Storing them would mean renaming a category leaves the old name on
 * every service beneath it, and nobody notices until a customer sees two names
 * for the same thing.
 *
 * **Pricing lives on the service, not in a `PricingRule` collection.** The type
 * is keyed by `serviceId` and is strictly one-to-one, so a separate collection
 * would be a join that buys nothing. `getPricingRules()` projects these fields.
 * *`ponytail:` pricing denormalised onto the service; split it out only if a
 * service ever needs more than one concurrent rule.*
 */

// -- Category ----------------------------------------------------------------

export interface CategoryDoc {
  _id: string;
  name: string;
  iconName: string;
  description: string;
  /** The order customers see on the app home grid. Admin 22 drag-to-reorder. */
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    _id: { type: String },
    name: { type: String, required: true, trim: true },
    iconName: { type: String, required: true, default: "Wrench" },
    description: { type: String, default: "", trim: true },
    sortOrder: { type: Number, required: true, default: 0, index: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const Category = model<CategoryDoc>("Category", categorySchema);

// -- Sub-category ------------------------------------------------------------

export interface SubCategoryDoc {
  _id: string;
  categoryId: string;
  name: string;
  iconName: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const subCategorySchema = new Schema<SubCategoryDoc>(
  {
    _id: { type: String },
    categoryId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    iconName: { type: String, required: true, default: "Wrench" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const SubCategory = model<SubCategoryDoc>(
  "SubCategory",
  subCategorySchema,
);

// -- Service -----------------------------------------------------------------

/**
 * A bookable option within a service. Admin 27.
 *
 * Priced as a **delta** against the service base price, per `@cfc/types`: so
 * changing the base price moves every variant with it, instead of leaving a set
 * of stale absolute numbers behind.
 */
export interface VariantDoc {
  id: string;
  name: string;
  priceDeltaPaise: number;
  durationMinutes: number;
  isDefault: boolean;
  active: boolean;
}

const variantSchema = new Schema<VariantDoc>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    priceDeltaPaise: { type: Number, required: true, default: 0 },
    durationMinutes: { type: Number, required: true, default: 60 },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

/** An optional extra bought alongside the service. Customer 14. */
export interface AddOnDoc {
  id: string;
  name: string;
  description: string;
  /** Absolute, not a delta — an add-on is separate work, not a variant. */
  pricePaise: number;
  durationMinutes: number;
  active: boolean;
}

const addOnSchema = new Schema<AddOnDoc>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    pricePaise: { type: Number, required: true, default: 0 },
    durationMinutes: { type: Number, required: true, default: 0 },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

export interface ServiceDoc {
  _id: string;
  /** The sub-category it sits under. The category is reached through it. */
  subCategoryId: string;
  name: string;
  description: string;
  /**
   * Relative paths under `/uploads`, never absolute URLs (§0.4), so moving the
   * host is a configuration change rather than a data migration. First is the
   * cover image on the service card.
   */
  imagePaths: string[];
  inclusions: string[];
  /**
   * Per-service, admin-editable. The fixtures had a flat 30 for everything and
   * no editor, which §2.6 flags — this is where that gets fixed.
   */
  warrantyDays: number;
  active: boolean;
  variants: VariantDoc[];
  addOns: AddOnDoc[];

  // -- Pricing. Admin 28. Every figure admin-editable, nothing hardcoded. ----
  basePricePaise: number;
  platformFeePaise: number;
  visitChargePaise: number;
  nightSurchargePaise: number;
  /** Admin 28 — one city may override the base price. */
  cityOverride?: { city: string; basePricePaise: number };

  createdAt: Date;
  updatedAt: Date;
}

const serviceSchema = new Schema<ServiceDoc>(
  {
    _id: { type: String },
    subCategoryId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    imagePaths: { type: [String], default: [] },
    inclusions: { type: [String], default: [] },
    warrantyDays: { type: Number, default: 30 },
    active: { type: Boolean, default: true },
    variants: { type: [variantSchema], default: [] },
    addOns: { type: [addOnSchema], default: [] },

    basePricePaise: { type: Number, required: true, default: 0 },
    platformFeePaise: { type: Number, required: true, default: 0 },
    visitChargePaise: { type: Number, required: true, default: 0 },
    nightSurchargePaise: { type: Number, required: true, default: 0 },
    cityOverride: {
      type: new Schema(
        {
          city: { type: String, required: true },
          basePricePaise: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: true, versionKey: false },
);

/**
 * Text index for search. Clause 4.8 names *"MongoDB indexing for search"* as a
 * contractual deliverable, so it is declared here rather than added later —
 * and it is the reason `searchServices` does not need Elasticsearch for a
 * catalogue of this size.
 *
 * `name` is weighted above `description`: someone searching "AC" wants the AC
 * service, not every description that mentions air conditioning.
 */
serviceSchema.index(
  { name: "text", description: "text" },
  { weights: { name: 10, description: 1 }, name: "service_search" },
);

export const Service = model<ServiceDoc>("Service", serviceSchema);

// -- Commission --------------------------------------------------------------

/**
 * Admin 29 — commission per category, per pro, or per partner.
 *
 * Its own collection, unlike pricing: a rule's target is one of three different
 * kinds of thing, and there can be none, one or many. The platform default
 * (15%, per the agreement) is not stored here — it lives in settings, so a
 * catalogue with no rules still has a rate.
 */
export interface CommissionRuleDoc {
  _id: string;
  scope: "category" | "pro" | "partner";
  /** The id of the category, pro or partner this applies to. */
  targetId: string;
  commissionBps: number;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const commissionRuleSchema = new Schema<CommissionRuleDoc>(
  {
    _id: { type: String },
    scope: {
      type: String,
      required: true,
      enum: ["category", "pro", "partner"],
    },
    targetId: { type: String, required: true },
    // Basis points, never a percentage float: `primitives.ts` insists on this,
    // and 1500 is exact where 0.15 invites rounding arguments about money.
    commissionBps: { type: Number, required: true },
    note: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false },
);

commissionRuleSchema.index({ scope: 1, targetId: 1 }, { unique: true });

export const CommissionRule = model<CommissionRuleDoc>(
  "CommissionRule",
  commissionRuleSchema,
);
