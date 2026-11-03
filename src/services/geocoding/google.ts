import { env } from "../../env";
import type { GeocodeOutcome } from "./index";

/**
 * Reverse geocoding via Google's Geocoding API.
 *
 * Kept wired and compiled even while `GEOCODER=osm`, so switching back is an
 * environment value rather than rewriting this from memory later.
 *
 * **Needs an activated billing account.** Not merely a linked one: in India
 * Google requires a one-off ₹1,000 prepayment before it serves a single
 * request, and until that clears every call answers `REQUEST_DENIED` with
 * "You must enable Billing" — which is exactly what this returned during
 * development, and why OSM is the default.
 */

interface GoogleResponse {
  status: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    address_components?: { long_name: string; types: string[] }[];
  }[];
}

/**
 * Picks the best component for a role, trying each type in order.
 *
 * Google's component types vary by country and by how well-mapped a place is.
 * In India an "area" may come back as `sublocality_level_1`, or only as
 * `locality` in a smaller town, so this tries them from most specific to least
 * rather than assuming one shape.
 */
function component(
  components: { long_name: string; types: string[] }[],
  types: string[],
): string {
  for (const type of types) {
    const found = components.find((c) => c.types.includes(type));
    if (found) return found.long_name;
  }
  return "";
}

export async function googleReverse(
  lat: number,
  lng: number,
): Promise<GeocodeOutcome> {
  if (!env.mapsServerKey) {
    return { ok: false, reason: "GOOGLE_MAPS_SERVER_KEY is not set" };
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", env.mapsServerKey);
  url.searchParams.set("language", "en");
  url.searchParams.set("region", "in");

  let body: GoogleResponse;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    body = (await response.json()) as GoogleResponse;
  } catch {
    return { ok: false, reason: "Google did not answer in time" };
  }

  // Faults before the empty answer: `REQUEST_DENIED` arrives with an empty
  // `results` array, so checking "no results" first would report a billing
  // problem as "no address here".
  if (body.status !== "OK" && body.status !== "ZERO_RESULTS") {
    return {
      ok: false,
      reason: `Google answered ${body.status}: ${body.error_message ?? "no message"}`,
    };
  }

  const top = body.results?.[0];
  if (body.status === "ZERO_RESULTS" || !top) {
    return { ok: true, result: null };
  }

  const parts = top.address_components ?? [];

  // Every component that could be the locality, most specific outward — the
  // route matches these against the admin's service areas. Google's types vary
  // between a city and a village exactly as OSM's fields do.
  const candidates = [
    "sublocality_level_1",
    "sublocality",
    "neighborhood",
    "locality",
    "administrative_area_level_3",
    "administrative_area_level_2",
  ]
    .map((t) => component(parts, [t]))
    .filter((v) => v !== "");

  return {
    ok: true,
    result: {
      formatted: top.formatted_address ?? "",
      // The street only. The formatted address repeats city, state and pincode,
      // which the form stores in their own fields and would otherwise show twice.
      line1: [
        component(parts, ["premise", "street_number"]),
        component(parts, ["route"]),
      ]
        .filter(Boolean)
        .join(" "),
      area: candidates[0] ?? "",
      areaCandidates: candidates,
      city: component(parts, [
        "locality",
        "administrative_area_level_3",
        "administrative_area_level_2",
      ]),
      state: component(parts, ["administrative_area_level_1"]),
      pincode: component(parts, ["postal_code"]),
    },
  };
}
