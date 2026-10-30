import { Schema, model } from "mongoose";

/**
 * Admin 37 — home-screen banners, with scheduling.
 *
 * **Scheduling is the whole point of the screen**, and it is the part that was
 * never built (§2.2). A banner is live when it is `active` *and* inside its
 * window, so a Diwali promotion can be loaded in advance and expire on its own
 * rather than relying on somebody remembering to switch it off on the day.
 *
 * Both window ends are nullable and mean "no bound": `scheduledFrom: null` is
 * live immediately, `scheduledTo: null` runs until switched off. A banner with
 * neither behaves exactly like a plain on/off toggle, which is what most of
 * them will be.
 */

export interface BannerDoc {
  _id: string;
  /** Relative path under the public upload root, never an absolute URL. */
  imagePath: string;
  title: string;
  linkType: "category" | "service" | "none";
  linkTarget: string | null;
  sortOrder: number;
  active: boolean;
  scheduledFrom: Date | null;
  scheduledTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const bannerSchema = new Schema<BannerDoc>(
  {
    _id: { type: String },
    imagePath: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    linkType: {
      type: String,
      required: true,
      enum: ["category", "service", "none"],
      default: "none",
    },
    linkTarget: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    scheduledFrom: { type: Date, default: null },
    scheduledTo: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

bannerSchema.index({ active: 1, sortOrder: 1 });

export const Banner = model<BannerDoc>("Banner", bannerSchema);

/**
 * The query for banners a customer should see right now.
 *
 * Kept here rather than in the route so the admin preview and the consumer
 * home screen cannot disagree about what "live" means — the usual way a
 * scheduled banner appears in one place and not the other.
 */
export function liveBannerFilter(now = new Date()): Record<string, unknown> {
  return {
    active: true,
    $and: [
      { $or: [{ scheduledFrom: null }, { scheduledFrom: { $lte: now } }] },
      { $or: [{ scheduledTo: null }, { scheduledTo: { $gte: now } }] },
    ],
  };
}
