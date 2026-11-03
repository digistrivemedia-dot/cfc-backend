import "dotenv/config";
import path from "node:path";

/**
 * Configuration, read once at boot.
 *
 * Every value a wrong setting could silently break is **required**, and the
 * process refuses to start without it. The alternative — a default that looks
 * plausible — is how a server ends up talking to the wrong database while
 * reporting itself healthy.
 *
 * Secrets are never logged. `describe()` below exists so boot can state what it
 * is configured as without printing any of it.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See apps/server/.env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${raw}".`);
  }
  return n;
}

const nodeEnv = optional("NODE_ENV", "development");
const isProduction = nodeEnv === "production";

/**
 * Where uploads land. Outside `src/` so a restart never serves a half-written
 * file from a watched directory, and absolute so it does not depend on the
 * working directory the process was started from.
 */
const uploadRoot = path.resolve(
  optional("UPLOAD_ROOT", path.join(process.cwd(), "uploads")),
);

export const env = {
  nodeEnv,
  isProduction,
  port: int("PORT", 4000),

  mongoUri: required("MONGODB_URI"),

  /** Signs the JWTs. A rotation invalidates every live session, by design. */
  jwtSecret: required("JWT_SECRET"),

  /**
   * Encrypts bank account numbers at rest (see auth/secret-box.ts).
   *
   * Separate from `JWT_SECRET` on purpose: rotating the session key should sign
   * everyone out, not make every stored bank detail undecryptable. **Losing
   * this value means every pro has to re-enter their bank details**, so it is
   * required rather than defaulted — a generated fallback would be silently
   * different on the next deploy.
   */
  bankEncryptionKey: required("BANK_ENCRYPTION_KEY"),

  /**
   * The super admin, per §0.2 of BACKEND-PLAN.md — the one credential that is
   * configuration rather than a database record, because it has to exist
   * before anyone can create anything.
   */
  superAdminEmail: required("SUPER_ADMIN_EMAIL"),
  superAdminPassword: required("SUPER_ADMIN_PASSWORD"),

  /**
   * Accept the master OTP while the DLT registration is outstanding.
   *
   * The OTP flow is real either way — generated, hashed, expiring, rate
   * limited. This only decides whether `AUTH_MASTER_OTP` is also accepted and
   * whether an SMS is actually dispatched.
   *
   * **Must be false in production.** Asserted at boot below, not left to
   * a deployment checklist.
   */
  dummyOtp: bool("AUTH_DUMMY_OTP", !isProduction),
  masterOtp: optional("AUTH_MASTER_OTP", "123456"),

  uploadRoot,

  /**
   * Server-side Google Maps key, for reverse geocoding.
   *
   * **Separate from the browser key on purpose.** The Maps JavaScript key ships
   * in the page and cannot be hidden, so it is restricted by HTTP referrer and
   * limited to Maps + Places. Geocoding is called from here instead, with a key
   * restricted by IP that never reaches a browser — otherwise anyone reading
   * devtools can spend the geocoding quota.
   *
   * Optional: without it `/consumer/geocode/reverse` answers 503 and the
   * address form falls back to typed entry rather than the whole app failing to
   * boot over a key that is not needed to browse.
   */
  mapsServerKey: optional("GOOGLE_MAPS_SERVER_KEY", ""),

  /**
   * Which geocoder turns a map pin into an address: `osm` or `google`.
   *
   * **Defaults to `osm`, which needs no key and costs nothing.** Google's
   * Geocoding API requires an activated billing account — in India that means a
   * ₹1,000 prepayment before a single request is served — so it is not the
   * default, only an option.
   *
   * Switching is this one value plus a restart. Both implementations return the
   * identical shape, so nothing above them changes.
   */
  geocoder: optional("GEOCODER", "osm"),

  /**
   * Geoapify key, for the OSM geocoder.
   *
   * Optional. Without it the OSM provider calls public Nominatim, which is free
   * and needs no signup but is rate-limited to roughly one request a second and
   * whose policy does not cover commercial use. With it, the same provider uses
   * Geoapify's free tier instead: proper terms, no ban risk, still no card.
   *
   * Free key: https://myprojects.geoapify.com — sign up, create a project,
   * copy the API key.
   */
  geoapifyKey: optional("GEOAPIFY_API_KEY", ""),

  /**
   * Browser origins allowed to call the API. The three Next apps in dev.
   *
   * An allowlist rather than `*` from the first commit: these endpoints carry
   * a bearer token, and a permissive CORS policy set "temporarily" is the kind
   * of thing that ships.
   */
  corsOrigins: optional(
    "CORS_ORIGINS",
    "http://localhost:3000,http://localhost:3001,http://localhost:3002",
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

if (env.isProduction && env.dummyOtp) {
  throw new Error(
    "AUTH_DUMMY_OTP must not be true in production — it accepts a master OTP " +
      "for every account. Set it to false and configure MSG91.",
  );
}

/** What boot prints. Names the configuration without revealing any of it. */
export function describe(): Record<string, string | number | boolean> {
  return {
    nodeEnv: env.nodeEnv,
    port: env.port,
    // Host and database only — the credentials in the URI stay out of logs.
    mongo: env.mongoUri.replace(/\/\/[^@]*@/, "//<redacted>@"),
    uploadRoot: env.uploadRoot,
    dummyOtp: env.dummyOtp,
    corsOrigins: env.corsOrigins.join(" "),
  };
}
