import { Schema, model } from "mongoose";

/**
 * Coupons. Admin 35, 36 and Customer 19.
 *
 * `usedCount` is incremented **atomically and guarded** when a booking redeems
 * it — see `redeemCoupon` below. A read-then-write would let a popular coupon
 * over-redeem under concurrency, which is the one way a discount costs more
 * than the campaign was budgeted for.
 */

export interface CouponDoc {
  _id: string;
  /** Stored uppercase; matched case-insensitively. */
  code: string;
  discountType: "percent" | "flat";
  /** A percentage (20) or an amount in paise, depending on `discountType`. */
  discountValue: number;
  /** 0 means unlimited. */
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  firstBookingOnly: boolean;
  restrictions: {
    /** Empty means every area. */
    areas: string[];
    /** Empty means every service. */
    serviceIds: string[];
    /** 0 means no floor. Guards a flat discount exceeding the booking. */
    minOrderPaise: number;
    /** 0 means uncapped. Caps a percentage discount in rupees. */
    maxDiscountPaise: number;
    /** How many times one customer may use it. 0 means no limit. */
    perCustomerLimit: number;
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponDoc>(
  {
    _id: { type: String },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    discountType: { type: String, required: true, enum: ["percent", "flat"] },
    discountValue: { type: Number, required: true },
    maxUses: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    firstBookingOnly: { type: Boolean, default: false },
    restrictions: {
      type: new Schema(
        {
          areas: { type: [String], default: [] },
          serviceIds: { type: [String], default: [] },
          minOrderPaise: { type: Number, default: 0 },
          maxDiscountPaise: { type: Number, default: 0 },
          perCustomerLimit: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const Coupon = model<CouponDoc>("Coupon", couponSchema);

/**
 * Claims one use of a coupon, atomically.
 *
 * The filter carries the guard, so Mongo decides: a coupon at its limit matches
 * nothing and this returns null. Checking `usedCount < maxUses` in application
 * code and then incrementing is the classic race — two requests both read 99 of
 * 100 and both succeed.
 *
 * `$expr` because the limit is a field on the same document, and `maxUses: 0`
 * means unlimited rather than "none left".
 */
export async function redeemCoupon(code: string): Promise<boolean> {
  const claimed = await Coupon.findOneAndUpdate(
    {
      code: code.toUpperCase(),
      active: true,
      expiresAt: { $gt: new Date() },
      $expr: {
        $or: [
          { $eq: ["$maxUses", 0] },
          { $lt: ["$usedCount", "$maxUses"] },
        ],
      },
    },
    { $inc: { usedCount: 1 } },
    { new: true },
  ).lean();

  return claimed !== null;
}

/** Gives a use back when the booking it was claimed for could not be created. */
export async function releaseCoupon(code: string): Promise<void> {
  await Coupon.updateOne(
    { code: code.toUpperCase(), usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
  );
}
