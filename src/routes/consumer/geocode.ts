import { Router } from "express";
import { badRequest, forbidden, notConfigured } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { getSettings } from "../../models/settings";
import {
  activeGeocoder,
  pickArea,
  reverseGeocode,
} from "../../services/geocoding";

/**
 * Reverse geocoding, proxied.
 *
 * The address form needs coordinates turned into readable text: a street for
 * `line1`, and the area, city, state and pincode that dispatch and pricing
 * actually match on.
 *
 * ## Why this is a proxy and not a browser call
 *
 * Whichever provider is active, the key stays here. Geoapify's and Google's
 * both would work from the page, but a key in a page cannot be hidden — only
 * restricted — and a geocoding quota is money. Public Nominatim additionally
 * requires an identifying `User-Agent`, which a browser will not let a script
 * set at all.
 *
 * It also means the provider switch is invisible to the apps: they call one URL
 * and get one shape, whether OSM or Google answered.
 *
 * ## Why it is authenticated and rate limited
 *
 * An open proxy to someone else's API is a bill, or a ban, that a stranger can
 * trigger. Signed-in customers only, and capped per account — a person placing
 * a pin drags it a few times, not three hundred.
 */
export const consumerGeocodeRouter = Router();

consumerGeocodeRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

consumerGeocodeRouter.get(
  "/reverse",
  rateLimit({
    // Public Nominatim's policy is about one request a second, and this
    // endpoint is the only thing calling it. 30/minute leaves room for a
    // customer nudging the pin without ever approaching that.
    windowSeconds: 60,
    max: 30,
    message: "Too many location lookups. Please wait a moment.",
  }),
  async (req, res) => {
    const lat = Number(req.query["lat"]);
    const lng = Number(req.query["lng"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw badRequest("Where should we look?", "MISSING_POINT");
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw badRequest("That is not a point on Earth.", "BAD_POINT");
    }

    const [outcome, { serviceAreas, servicePincodes }] = await Promise.all([
      reverseGeocode(lat, lng),
      getSettings(),
    ]);

    if (!outcome.ok) {
      // The provider's own words, named with which provider said them, because
      // "address lookup failed" costs an hour of guessing at setup time.
      console.error(`[geocode:${activeGeocoder()}] ${outcome.reason}`);
      throw notConfigured("Address lookup");
    }

    // A point that resolved to nothing — the sea, an unmapped field. A real
    // answer, not a fault: the form keeps the pin and asks for typed input.
    const found = outcome.result;

    /**
     * The locality, chosen against what the admin actually serves.
     *
     * Not simply the provider's first guess. OSM returns a Srirangam pin as
     * `suburb: "Trichy Zone I"`, `county: "Srirangam"` — taking the first field
     * would store an area that matches no pro while looking entirely
     * reasonable. `pickArea` takes whichever candidate names a real service
     * area, and falls back to the provider's guess when none do.
     */
    const area = found ? pickArea(found, serviceAreas) : "";

    res.json({
      formatted: found?.formatted ?? "",
      line1: found?.line1 ?? "",
      area,
      city: found?.city ?? "",
      state: found?.state ?? "",
      pincode: found?.pincode ?? "",
      /**
       * Whether CFC operates here.
       *
       * Returned with the lookup so the form can say so **while the customer is
       * still on the map**, rather than after they have filled in five fields.
       * The address still saves either way — losing something somebody
       * carefully typed is worse than holding one we cannot serve yet — but
       * booking from it is refused.
       */
      // By pincode, not by name. A geocoder renaming an area must not make a
      // serviced address unbookable.
      serviceable: servicePincodes.includes((found?.pincode ?? "").trim()),
      /** So the form can name where we do operate, instead of a bare refusal. */
      serviceAreas,
      servicePincodes,
    });
  },
);
