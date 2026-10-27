import type { PriceBreakdown } from "@cfc/types";
import { CGST_BPS, SGST_BPS } from "@cfc/types";
import type { ServiceDoc } from "../models/catalog";

/**
 * What a customer pays, itemised. **Ported from `booking-draft.ts`, not
 * re-derived.**
 *
 * BACKEND-PLAN.md §9 is firm about this, and the reason is specific: the money
 * rules were worked out once, documented with their reasoning, and verified.
 * Re-deriving them from the agreement is how GST ends up charged on the
 * professional's labour.
 *
 * The rules, each of which the mock already implements and this preserves:
 *
 * - **GST is on the platform fee only.** CGST 9% + SGST 9% *of the platform
 *   fee*, never of the subtotal. Computing it the other way overcharges every
 *   customer and surfaces in an audit rather than in testing.
 * - **The discount comes off the work, before fees.** A coupon discounts the
 *   service and its add-ons, not CFC's fee — so the platform fee and its GST
 *   are unchanged by it.
 * - **A discount never exceeds the work it applies to**, or the total goes
 *   negative and the customer is owed money for booking.
 * - **Quantity multiplies only the work.** The visit charge covers getting a
 *   pro to the door and the platform fee covers taking the booking; neither
 *   happens twice because someone asked for two bathrooms cleaned in one visit.
 * - **Add-ons are charged once per booking, not per unit.** Someone booking
 *   three ACs and one deep-clean wants one deep clean.
 *
 * `CGST_BPS` and `SGST_BPS` come from `@cfc/types`, so the server and the
 * client cannot disagree about the rate.
 */

export interface PriceInput {
  service: Pick<
    ServiceDoc,
    "basePricePaise" | "platformFeePaise" | "visitChargePaise" | "variants" | "addOns"
  >;
  /** The chosen variant, or null for the service's default. */
  variantId?: string | null;
  /** Ids of the chosen add-ons. */
  addOnIds?: string[];
  discountPaise?: number;
  quantity?: number;
  /** Set when a city override applies. Replaces the base price. */
  overrideBasePricePaise?: number | undefined;
}

export function priceBooking(input: PriceInput): PriceBreakdown {
  const { service } = input;

  const base = input.overrideBasePricePaise ?? service.basePricePaise;
  const visitChargePaise = service.visitChargePaise;
  const platformFeePaise = service.platformFeePaise;

  // No variant chosen falls back to the one marked default, which is how the
  // customer's screen pre-selects it — so an unspecified variant prices the
  // same as the one they are looking at.
  const variant =
    service.variants.find((v) => v.id === input.variantId) ??
    service.variants.find((v) => v.isDefault);
  const variantDeltaPaise = variant?.priceDeltaPaise ?? 0;

  const chosenIds = new Set(input.addOnIds ?? []);
  const addOnsPaise = service.addOns
    .filter((a) => chosenIds.has(a.id) && a.active)
    .reduce((sum, a) => sum + a.pricePaise, 0);

  const units = Math.max(1, Math.floor(input.quantity ?? 1));
  const servicePaise = (base + variantDeltaPaise) * units;
  const extrasPaise = Math.max(0, addOnsPaise);

  const capped = Math.min(
    Math.max(0, input.discountPaise ?? 0),
    servicePaise + extrasPaise,
  );

  const cgstPaise = Math.round((platformFeePaise * CGST_BPS) / 10_000);
  const sgstPaise = Math.round((platformFeePaise * SGST_BPS) / 10_000);

  return {
    servicePaise,
    addOnsPaise: extrasPaise,
    visitChargePaise,
    platformFeePaise,
    discountPaise: capped,
    cgstPaise,
    sgstPaise,
    totalPaise:
      servicePaise +
      extrasPaise -
      capped +
      visitChargePaise +
      platformFeePaise +
      cgstPaise +
      sgstPaise,
  };
}

/**
 * The duration a visit is expected to take, for the slot grid and the pro.
 *
 * Variant duration plus every chosen add-on's extra time. An add-on that adds
 * thirty minutes has to move the arrival window, or the next booking overlaps.
 */
export function durationMinutes(input: PriceInput): number {
  const { service } = input;
  const variant =
    service.variants.find((v) => v.id === input.variantId) ??
    service.variants.find((v) => v.isDefault);

  const chosenIds = new Set(input.addOnIds ?? []);
  const extra = service.addOns
    .filter((a) => chosenIds.has(a.id) && a.active)
    .reduce((sum, a) => sum + a.durationMinutes, 0);

  return (variant?.durationMinutes ?? 60) + extra;
}
