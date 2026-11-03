import { env } from "../../env";
import type { GeocodeOutcome, GeocodeResult } from "./index";

/**
 * Reverse geocoding from OpenStreetMap data. The default provider.
 *
 * Free, and needs no billing account — which is the whole reason it is the
 * default. Two back ends, picked by whether a Geoapify key is set:
 *
 *   **Geoapify** (`GEOAPIFY_API_KEY` set) — OSM data served under commercial
 *   terms, ~3,000 requests a day free, no card. What a real deployment should
 *   use.
 *
 *   **Public Nominatim** (no key) — OSM's own geocoder. Genuinely free and
 *   needs no signup, so the app works the moment it is cloned. Its usage policy
 *   caps you at roughly **one request per second**, requires an identifying
 *   `User-Agent`, and does not cover commercial use. Fine for development and a
 *   demo; get a Geoapify key before real customers arrive.
 *
 * Both return OSM's own field names, which is why one translator covers them.
 */

/** Identifies this app to Nominatim, as its policy requires. */
const USER_AGENT = "CityFamilyCare/1.0 (+https://cityfamilycare.in)";

/**
 * OSM's address fields, as both back ends return them.
 *
 * Every field is optional because OSM's completeness varies enormously by
 * place: a Trichy suburb may carry `suburb` and `postcode` and no `road`, while
 * a village has `village` and nothing else.
 */
interface OsmAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  village?: string;
  town?: string;
  city?: string;
  city_district?: string;
  county?: string;
  state_district?: string;
  state?: string;
  postcode?: string;
}

interface NominatimResponse {
  error?: string;
  display_name?: string;
  /** The building or landmark under the pin, when OSM has mapped one. */
  name?: string;
  address?: OsmAddress;
}

interface GeoapifyResponse {
  features?: {
    properties?: OsmAddress & {
      formatted?: string;
      /** House number + street, already assembled by Geoapify. */
      address_line1?: string;
      name?: string;
      suburb?: string;
      district?: string;
      postcode?: string;
      state?: string;
      city?: string;
    };
  }[];
}

/**
 * OSM's fields to ours.
 *
 * `area` is the one that matters: dispatch matches pros on it, so it has to be
 * the locality a person would name — the suburb, not the district. The fallback
 * chain walks outward from most specific, and ends at `city` so a small town
 * with no suburb still produces something rather than an empty string.
 */
function translate(
  a: OsmAddress,
  formatted: string,
  /** The provider's own name for the thing under the pin, when it has one. */
  placeName = "",
): GeocodeResult {
  // `state_district` before `city_district`: in Trichy, OSM returns
  // `state_district: "Tiruchirappalli"` (the city) and
  // `city_district: "Trichy Corporation Limits"` (an administrative boundary
  // nobody would ever write on an envelope).
  const city =
    a.city ?? a.town ?? a.village ?? a.state_district ?? a.city_district ?? "";

  /**
   * Every field that could be the locality, most specific outward.
   *
   * `county` is in here, and on Indian data it is often the one that holds the
   * name a person would use — a pin in Srirangam returns
   * `suburb: "Trichy Zone I"` and `county: "Srirangam"`.
   */
  const candidates = [
    a.suburb,
    a.neighbourhood,
    a.county,
    a.village,
    a.town,
    a.city_district,
    city,
  ].filter((v): v is string => typeof v === "string" && v.trim() !== "");

  /**
   * The street line, with a fallback chain rather than a blank.
   *
   * **`road` is often absent and that is normal.** Sampling real Trichy points:
   * a pin on a street returns `road: "Uthirai street"`, but a pin in the middle
   * of a block returns no road at all — only `neighbourhood: "Ward 3"`. Leaving
   * `line1` empty there left the customer staring at an empty required box with
   * nothing explaining why, which is what this chain fixes.
   *
   * The place name comes next because OSM frequently knows the building even
   * when it has not mapped the lane ("Trichy District Court"), and that is more
   * use to a professional at the door than a ward number.
   */
  const line1 =
    [a.house_number, a.road].filter(Boolean).join(" ") ||
    placeName ||
    a.neighbourhood ||
    // The first segment of the display name is the most specific thing OSM
    // knows about the point. Last resort, but never worse than empty.
    formatted.split(",")[0]?.trim() ||
    "";

  return {
    formatted,
    line1,
    area: candidates[0] ?? "",
    areaCandidates: candidates,
    city,
    state: a.state ?? "",
    pincode: a.postcode ?? "",
  };
}

export async function osmReverse(
  lat: number,
  lng: number,
): Promise<GeocodeOutcome> {
  return env.geoapifyKey
    ? geoapifyReverse(lat, lng)
    : nominatimReverse(lat, lng);
}

async function nominatimReverse(
  lat: number,
  lng: number,
): Promise<GeocodeOutcome> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  // 18 is roughly building level. Lower and a pin on a house answers with the
  // whole suburb, which would put the wrong thing in `line1`.
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en");

  let body: NominatimResponse;
  try {
    const response = await fetch(url, {
      // Required by Nominatim's policy. Requests without it are refused, and
      // an app that identifies itself is one they can contact before banning.
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      return { ok: false, reason: "Nominatim rate limit — set GEOAPIFY_API_KEY" };
    }
    body = (await response.json()) as NominatimResponse;
  } catch {
    return { ok: false, reason: "Nominatim did not answer in time" };
  }

  // Nominatim reports "Unable to geocode" as an error field, not a status.
  if (body.error || !body.address) return { ok: true, result: null };

  return {
    ok: true,
    result: translate(body.address, body.display_name ?? "", body.name ?? ""),
  };
}

async function geoapifyReverse(
  lat: number,
  lng: number,
): Promise<GeocodeOutcome> {
  const url = new URL("https://api.geoapify.com/v1/geocode/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "geojson");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", env.geoapifyKey);

  let body: GeoapifyResponse;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (response.status === 401) {
      return { ok: false, reason: "GEOAPIFY_API_KEY was rejected" };
    }
    body = (await response.json()) as GeoapifyResponse;
  } catch {
    return { ok: false, reason: "Geoapify did not answer in time" };
  }

  const props = body.features?.[0]?.properties;
  if (!props) return { ok: true, result: null };

  // Geoapify's `address_line1` is already "house number + street", and it
  // falls back to the building name on its own — so it is preferred over
  // rebuilding the same thing from parts.
  return {
    ok: true,
    result: translate(
      props,
      props.formatted ?? "",
      props.address_line1 ?? props.name ?? "",
    ),
  };
}
