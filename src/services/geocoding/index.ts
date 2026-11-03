import { env } from "../../env";
import { googleReverse } from "./google";
import { osmReverse } from "./osm";

/**
 * Reverse geocoding, behind one interface.
 *
 * Two providers, identical in and out, chosen by `GEOCODER` in the environment:
 *
 *   `osm`     (default) OpenStreetMap — Nominatim, or Geoapify when keyed.
 *             Free. No billing account, no card.
 *   `google`  Google's Geocoding API. More accurate on Indian addresses, and
 *             requires an activated billing account to answer at all.
 *
 * ## Why an interface rather than swapping the call
 *
 * The route above this does not know or care which one answers. That is the
 * whole point: switching provider is one environment value and a restart, with
 * no edit to the route, the response shape, or anything in the apps. Equally,
 * the provider that is *not* selected stays compiled and tested rather than
 * being deleted and rewritten later from memory.
 *
 * ## The shape is the contract
 *
 * Both return `GeocodeResult`. Where a provider has no answer for a field it
 * returns an empty string, never a guess — the address form treats empty as
 * "type it yourself", which is honest, while a plausible wrong street is not.
 */

export interface GeocodeResult {
  /** The provider's own one-line rendering. Shown under the pin. */
  formatted: string;
  /** Just the street. City, state and pincode are separate fields. */
  line1: string;
  /**
   * The provider's best single guess at the locality.
   *
   * Used only when none of `areaCandidates` matches a service area.
   */
  area: string;
  /**
   * Every field that could plausibly be the locality, most specific first.
   *
   * **This exists because no single field is right.** A pin in Srirangam comes
   * back from OSM with `suburb: "Trichy Zone I"` and `county: "Srirangam"` —
   * the service area is in `county`, and reading `suburb` would have produced
   * an address that fails the serviceable check while looking perfectly
   * plausible. Google's component types vary the same way between a city and a
   * village.
   *
   * So the route matches these against the admin's own service-area list and
   * takes the one that hits, which is the only definition of "right" that
   * matters here: `area` is what dispatch pairs with a pro.
   */
  areaCandidates: string[];
  city: string;
  state: string;
  pincode: string;
}

/**
 * The locality to store, given what the admin actually serves.
 *
 * Returns the first candidate that names a service area, or the provider's own
 * best guess when none do — which is the out-of-area case, and the form says so.
 */
export function pickArea(result: GeocodeResult, serviceAreas: string[]): string {
  const known = new Set(serviceAreas.map((s) => s.trim().toLowerCase()));
  const hit = result.areaCandidates.find((c) =>
    known.has(c.trim().toLowerCase()),
  );
  return hit ?? result.area;
}

/** `null` when the provider is not configured; `ZERO_RESULTS` is an empty result. */
export type GeocodeOutcome =
  | { ok: true; result: GeocodeResult }
  /** The point resolved to nothing — the sea, an unmapped field. Not a fault. */
  | { ok: true; result: null }
  /** Misconfigured or unreachable. `reason` is for the server log, not the user. */
  | { ok: false; reason: string };

/** Which provider is active. Exposed so the route can name it in a log line. */
export function activeGeocoder(): "osm" | "google" {
  return env.geocoder === "google" ? "google" : "osm";
}

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodeOutcome> {
  return activeGeocoder() === "google"
    ? googleReverse(lat, lng)
    : osmReverse(lat, lng);
}
