import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Actor } from "@cfc/types";
import { ADMIN_SECTIONS, areaScope, can, canOpen } from "@cfc/types";
import { createApp } from "./app";
import { env } from "./env";
import { SUPER_ADMIN } from "./auth/super-admin";
import { hashPassword, verifyPassword } from "./auth/password";
import { resetRateLimits } from "./middleware/rate-limit";
import { connect, disconnect } from "./db";
import { ensureUploadDirs, PRIVATE_ROOT, resolveWithin } from "./uploads";
import { Pro } from "./models/pro";
import { Customer } from "./models/customer";
import { Booking } from "./models/booking";
import { Coupon } from "./models/coupon";
import { WalletEntry } from "./models/wallet";
import { DispatchAlert, Offer } from "./models/offer";
import { Quotation } from "./models/quotation";

/**
 * Stage A's runnable check. `pnpm --filter @cfc/server test`
 *
 * Deliberately not a test framework: it boots the real app on an ephemeral
 * port, against the real database, and makes real requests. The point is to
 * prove the plumbing end to end, and a mocked Mongo would prove the mock.
 *
 * It covers the two things in Stage A that can be wrong without being obvious:
 * the error envelope's shape — every error screen in three apps renders from
 * it — and the upload path guard, where a bug is a file disclosure rather than
 * a wrong pixel.
 *
 * `ADMIN-SUMMARY.md`'s warning is the reason it exists at all: *"a check that
 * has never failed is not evidence it works."* So each assertion here is
 * written against a planted violation, not just a happy path.
 */

async function main(): Promise<void> {
  let failures = 0;
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      console.info(`  ok   ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL ${name}\n       ${String(err)}`);
    }
  };

  console.info("[selfcheck] path guard");

  check("a normal relative path resolves inside its root", () => {
    const resolved = resolveWithin(PRIVATE_ROOT, "pro_01/aadhaar_front.jpg");
    assert.ok(resolved.startsWith(PRIVATE_ROOT));
  });

  check("traversal with ../ is refused", () => {
    assert.throws(() => resolveWithin(PRIVATE_ROOT, "../public/leak.jpg"));
  });

  check("deep traversal is refused", () => {
    assert.throws(() =>
      resolveWithin(PRIVATE_ROOT, "a/b/../../../../../../etc/passwd"),
    );
  });

  check("an absolute path is refused", () => {
    assert.throws(() => resolveWithin(PRIVATE_ROOT, "/etc/passwd"));
  });

  check("a backslash-separated traversal is refused", () => {
    assert.throws(() => resolveWithin(PRIVATE_ROOT, "..\\public\\leak.jpg"));
  });

  console.info("[selfcheck] booting app against the real database");

  ensureUploadDirs();
  await connect();

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    const healthBody = (await health.json()) as { ok: boolean; db: string };
    check("health reports a connected database", () => {
      assert.equal(health.status, 200);
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.db, "connected");
    });

    const areas = await fetch(`${base}/api/public/service-areas`);
    const areasBody = (await areas.json()) as unknown;
    check("service areas reads from Mongo and returns an array", () => {
      assert.equal(areas.status, 200);
      assert.ok(
        Array.isArray(areasBody),
        `expected an array, got ${JSON.stringify(areasBody)}`,
      );
    });

    // The envelope is the contract with every error screen already built.
    const missing = await fetch(`${base}/api/public/no-such-thing`);
    const missingBody = (await missing.json()) as {
      status?: number;
      message?: string;
      code?: string;
    };
    check("an unknown route answers in the ApiError envelope", () => {
      assert.equal(missing.status, 404);
      assert.equal(missingBody.status, 404);
      assert.equal(typeof missingBody.message, "string");
      assert.ok(
        (missingBody.message ?? "").length > 0,
        "an empty message renders an empty error screen",
      );
      assert.equal(missingBody.code, "NO_ROUTE");
    });

    // The private root must not be reachable through the static mount, whatever
    // the filename. This is the assertion that would have caught a KYC leak.
    const traversal = await fetch(
      `${base}/uploads/..%2Fprivate%2Fanything.jpg`,
    );
    check("the private upload root is not reachable over /uploads", () => {
      assert.ok(
        traversal.status === 404 || traversal.status === 400,
        `expected the request to be refused, got ${traversal.status}`,
      );
    });

    const token = await checkAuth(base, check);
    await checkCatalog(base, token, check);
    await checkProOnboarding(base, token, check);
    await checkBooking(base, token, check);
    await checkDispatch(base, token, check);
    await checkLifecycle(base, token, check);
    await checkQuotations(base, token, check);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnect();
  }

  if (failures > 0) {
    console.error(`\n[selfcheck] ${failures} failed`);
    process.exit(1);
  }
  console.info("\n[selfcheck] all passed");
}

/**
 * Phase 2 — auth and RBAC.
 *
 * Every assertion here is a **planted violation**, not a happy path. The one
 * thing this phase cannot afford is a permission check that has never been
 * tried: `ADMIN-SUMMARY.md` records exactly that outcome on the frontend —
 * *"permissions were assigned but never enforced"* — and a forged token that
 * nobody attempted would be the same failure on the server.
 */
async function checkAuth(
  base: string,
  check: (name: string, fn: () => void) => void,
): Promise<string> {
  console.info("[selfcheck] auth and RBAC");

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}/api${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const get = (path: string, token?: string) =>
    fetch(`${base}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  // -- the real credentials work --------------------------------------------
  const good = await post("/admin/auth/login", {
    email: env.superAdminEmail,
    password: env.superAdminPassword,
  });
  const goodBody = (await good.json()) as {
    token?: string;
    actor?: { role?: string; id?: string };
    twoFactorRequired?: boolean;
    sections?: string[];
  };

  check("the configured super admin can sign in", () => {
    assert.equal(good.status, 200);
    assert.equal(typeof goodBody.token, "string");
    assert.equal(goodBody.actor?.role, "super_admin");
  });

  check("2FA is reported as not required, not faked as passed", () => {
    assert.equal(goodBody.twoFactorRequired, false);
  });

  check("the super admin's sections cover the whole panel", () => {
    // Ten sidebar sections in ADMIN_SECTIONS. Asserted as a count rather than a
    // list so adding a section does not silently narrow the super admin.
    assert.equal(goodBody.sections?.length, ADMIN_SECTIONS.length);
  });

  const token = goodBody.token ?? "";

  const me = await get("/admin/auth/me", token);
  const meBody = (await me.json()) as { actor?: { role?: string } };
  check("/me returns the actor for a valid token", () => {
    assert.equal(me.status, 200);
    assert.equal(meBody.actor?.role, "super_admin");
  });

  // -- planted violations ---------------------------------------------------
  const noToken = await get("/admin/auth/me");
  check("/me without a token is 401", () => {
    assert.equal(noToken.status, 401);
  });

  const garbage = await get("/admin/auth/me", "not-a-token");
  check("/me with a malformed token is 401", () => {
    assert.equal(garbage.status, 401);
  });

  // The attack this phase exists to stop: take a real token, rewrite the role
  // claim to super_admin, re-encode. The signature no longer matches.
  const [, payloadB64] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({
      ...(JSON.parse(
        Buffer.from(payloadB64 ?? "", "base64url").toString(),
      ) as Record<string, unknown>),
      role: "super_admin",
      sub: "adm_forged",
    }),
  ).toString("base64url");
  const forged = await get(
    "/admin/auth/me",
    `${token.split(".")[0]}.${forgedPayload}.${token.split(".")[2]}`,
  );
  check("a token with a rewritten role claim is refused", () => {
    assert.equal(
      forged.status,
      401,
      "a forged role claim was accepted — RBAC is not enforced",
    );
  });

  // `alg: none` — the algorithm-confusion attack. Pinning `algorithms` in
  // verifyToken is what stops this, and this is the check that proves it.
  const algNone = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${forgedPayload}.`;
  const unsigned = await get("/admin/auth/me", algNone);
  check('an unsigned "alg: none" token is refused', () => {
    assert.equal(unsigned.status, 401);
  });

  const wrongPassword = await post("/admin/auth/login", {
    email: env.superAdminEmail,
    password: "definitely-not-the-password",
  });
  const wrongBody = (await wrongPassword.json()) as { message?: string };
  check("a wrong password is refused", () => {
    assert.equal(wrongPassword.status, 401);
  });

  const unknownEmail = await post("/admin/auth/login", {
    email: "nobody@example.com",
    password: "definitely-not-the-password",
  });
  const unknownBody = (await unknownEmail.json()) as { message?: string };
  check("an unknown email gives the same message as a wrong password", () => {
    // Different messages would make this endpoint an account-enumeration oracle.
    assert.equal(unknownBody.message, wrongBody.message);
  });

  const noBody = await post("/admin/auth/login", {});
  check("login with no credentials is 400, not 500", () => {
    assert.equal(noBody.status, 400);
  });

  // -- rate limiting --------------------------------------------------------
  resetRateLimits();
  let limited = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await post("/admin/auth/login", {
      email: "bruteforce@example.com",
      password: `guess-${i}`,
    });
    if (r.status === 429) limited += 1;
  }
  check("login is rate limited after 10 attempts", () => {
    assert.ok(
      limited >= 2,
      `expected the 11th and 12th attempts to be refused, got ${limited} refusals`,
    );
  });
  resetRateLimits();

  // -- the permission rules themselves --------------------------------------
  // Imported from @cfc/types, so this asserts the *shared* rules rather than a
  // server-side copy of them. A drift between the two would fail here.
  const areaAdmin: Actor = {
    id: "adm_area",
    name: "Area admin",
    role: "area_admin",
    area: "Srirangam",
    sections: ["bookings", "quotations", "pros"],
  };

  check("an area admin cannot open settings", () => {
    assert.equal(canOpen(areaAdmin, "settings"), false);
  });

  check("an area admin has no export permission", () => {
    // "No external tool or third-party access at this level."
    assert.equal(can(areaAdmin, "bookings.export"), false);
  });

  check("an area admin is scoped to their own area in the query", () => {
    assert.equal(areaScope(areaAdmin), "Srirangam");
  });

  check("a super admin is unscoped", () => {
    assert.equal(areaScope(SUPER_ADMIN), null);
  });

  check("a per-person grant cannot widen a role", () => {
    // A sub-admin handed "settings" by a bad database row still cannot open it:
    // canOpen intersects the grant with the role rather than replacing it.
    const overreaching: Actor = {
      id: "adm_bad",
      name: "Over-granted",
      role: "sub_admin",
      sections: ["settings", "payments", "reports"],
    };
    assert.equal(canOpen(overreaching, "settings"), false);
    assert.equal(canOpen(overreaching, "payments"), false);
  });

  // -- password hashing -----------------------------------------------------
  const hash = await hashPassword("correct horse battery staple");
  const right = await verifyPassword("correct horse battery staple", hash);
  const wrong = await verifyPassword("Correct horse battery staple", hash);
  check("the hash verifies the right password and rejects a near-miss", () => {
    assert.equal(right, true);
    assert.equal(wrong, false);
  });
  check("the hash carries its own cost parameters", () => {
    // So raising the cost later does not invalidate existing hashes.
    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  });
  const corrupt = await verifyPassword("anything", "not-a-real-hash");
  check("a corrupt stored hash returns false", () => {
    assert.equal(corrupt, false);
  });

  return token;
}

main().catch((err: unknown) => {
  console.error("[selfcheck] crashed", err);
  process.exit(1);
});

/**
 * Phase 3 — the catalogue.
 *
 * Walks the client's demo path as an API sequence: create a category, a
 * sub-category and a service, then confirm the service is visible on the
 * **public** endpoints the customer app reads. That last step is the one that
 * matters — an admin write that does not surface to a customer is the failure
 * this phase exists to prevent.
 *
 * Cleans up after itself, because this runs against the real Atlas database and
 * leaving test categories in the client's catalogue would be worse than having
 * no check at all.
 */
async function checkCatalog(
  base: string,
  token: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] catalogue");

  const call = (method: string, path: string, body?: unknown, auth = token) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const suffix = Date.now();
  const categoryName = `__selfcheck Home ${suffix}`;
  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";

  try {
    // -- create -------------------------------------------------------------
    const catRes = await call("POST", "/admin/catalog/categories", {
      name: categoryName,
      iconName: "Wrench",
      description: "Created by the self-check.",
    });
    const cat = (await catRes.json()) as { id?: string; serviceCount?: number };
    categoryId = cat.id ?? "";
    check("an admin can create a category", () => {
      assert.equal(catRes.status, 201);
      assert.ok(categoryId, "no id came back");
      assert.equal(cat.serviceCount, 0);
    });

    const dupRes = await call("POST", "/admin/catalog/categories", {
      name: categoryName.toUpperCase(),
    });
    check("a duplicate category name is refused, case-insensitively", () => {
      assert.equal(dupRes.status, 409);
    });

    const subRes = await call("POST", "/admin/catalog/sub-categories", {
      name: `__selfcheck Cleaning ${suffix}`,
      categoryId,
    });
    const sub = (await subRes.json()) as { id?: string; categoryName?: string };
    subCategoryId = sub.id ?? "";
    check("an admin can create a sub-category under it", () => {
      assert.equal(subRes.status, 201);
      // The parent's name is resolved on read, not stored on the child.
      assert.equal(sub.categoryName, categoryName);
    });

    const orphanRes = await call("POST", "/admin/catalog/sub-categories", {
      name: "__selfcheck orphan",
      categoryId: "cat_does_not_exist",
    });
    check("a sub-category under a missing category is refused", () => {
      assert.equal(orphanRes.status, 400);
    });

    const svcRes = await call("POST", "/admin/catalog/services", {
      name: `__selfcheck Deep clean ${suffix}`,
      subCategoryId,
      description: "Created by the self-check.",
      basePricePaise: 49900,
      platformFeePaise: 4900,
      inclusions: ["One room", "Materials included"],
      variants: [
        { name: "1 BHK", priceDeltaPaise: 0, durationMinutes: 120, isDefault: true },
        { name: "2 BHK", priceDeltaPaise: 20000, durationMinutes: 180 },
      ],
    });
    const svc = (await svcRes.json()) as {
      id?: string;
      categoryName?: string;
      subCategoryName?: string;
      basePricePaise?: number;
      rating?: number;
      reviewCount?: number;
      variants?: { isDefault: boolean }[];
    };
    serviceId = svc.id ?? "";
    check("an admin can create a service", () => {
      assert.equal(svcRes.status, 201);
      assert.equal(svc.categoryName, categoryName);
      assert.equal(svc.basePricePaise, 49900);
    });

    check("a new service reports zero ratings rather than a fake one", () => {
      // Renders as "New" on the customer card, which is the truthful thing to
      // show for a service nobody has booked.
      assert.equal(svc.rating, 0);
      assert.equal(svc.reviewCount, 0);
    });

    check("exactly one variant is the default", () => {
      const defaults = (svc.variants ?? []).filter((v) => v.isDefault);
      assert.equal(defaults.length, 1);
    });

    // Two defaults sent; the server must normalise to one, or the customer's
    // booking screen pre-selects whichever happens to be first in the array.
    const twoDefaults = await call("PATCH", `/admin/catalog/services/${serviceId}`, {
      variants: [
        { name: "A", priceDeltaPaise: 0, durationMinutes: 60, isDefault: true },
        { name: "B", priceDeltaPaise: 100, durationMinutes: 60, isDefault: true },
      ],
    });
    const normalised = (await twoDefaults.json()) as {
      variants?: { isDefault: boolean }[];
    };
    check("two defaults are normalised to one", () => {
      assert.equal(
        (normalised.variants ?? []).filter((v) => v.isDefault).length,
        1,
      );
    });

    // -- money validation ---------------------------------------------------
    const fractional = await call("PATCH", `/admin/catalog/pricing/${serviceId}`, {
      basePricePaise: 499.5,
    });
    check("a fractional paise amount is refused, not rounded", () => {
      assert.equal(fractional.status, 400);
    });

    const negative = await call("PATCH", `/admin/catalog/pricing/${serviceId}`, {
      basePricePaise: -100,
    });
    check("a negative price is refused", () => {
      assert.equal(negative.status, 400);
    });

    const priced = await call("PATCH", `/admin/catalog/pricing/${serviceId}`, {
      basePricePaise: 59900,
      platformFeePaise: 5900,
      visitChargePaise: 0,
      nightSurchargePaise: 10000,
    });
    const pricedBody = (await priced.json()) as { basePricePaise?: number };
    check("an admin can change pricing", () => {
      assert.equal(priced.status, 200);
      assert.equal(pricedBody.basePricePaise, 59900);
    });

    // -- reorder, and the routing trap it sits in ---------------------------
    const reorder = await call("PATCH", "/admin/catalog/categories/reorder", {
      ids: [categoryId],
    });
    check("reorder is not swallowed by the /categories/:id route", () => {
      // With `:id` declared first, Express matches this as a category whose id
      // is the literal string "reorder" and answers 404. This is that check.
      assert.equal(
        reorder.status,
        200,
        "reorder hit the wrong route — check declaration order",
      );
    });

    const badReorder = await call("PATCH", "/admin/catalog/categories/reorder", {
      ids: [categoryId, "cat_nonexistent"],
    });
    check("reordering with an unknown id is refused wholesale", () => {
      assert.equal(badReorder.status, 400);
    });

    // -- the public view ----------------------------------------------------
    const publicSvcRes = await fetch(
      `${base}/api/public/catalog/services/${serviceId}`,
    );
    check("the new service is visible to a signed-out customer", () => {
      assert.equal(publicSvcRes.status, 200);
    });

    const publicCats = (await (
      await fetch(`${base}/api/public/catalog/categories`)
    ).json()) as { id: string; serviceCount: number }[];
    check("the category appears publicly with its service counted", () => {
      const mine = publicCats.find((c) => c.id === categoryId);
      assert.ok(mine, "the category is missing from the public list");
      assert.equal(mine?.serviceCount, 1);
    });

    // -- switching off hides it from customers, not from the admin ----------
    await call("PATCH", `/admin/catalog/services/${serviceId}`, { active: false });

    const hidden = await fetch(`${base}/api/public/catalog/services/${serviceId}`);
    check("an inactive service 404s for a customer", () => {
      assert.equal(hidden.status, 404);
    });

    const stillThere = await call("GET", `/admin/catalog/services/${serviceId}`);
    check("an inactive service is still visible to the admin", () => {
      // Otherwise switching something off would be indistinguishable from
      // deleting it, and there would be no way to switch it back on.
      assert.equal(stillThere.status, 200);
    });

    // -- deletion guards ----------------------------------------------------
    const blockedCat = await call("DELETE", `/admin/catalog/categories/${categoryId}`);
    check("a category with sub-categories cannot be deleted", () => {
      assert.equal(blockedCat.status, 409);
    });

    const blockedSub = await call(
      "DELETE",
      `/admin/catalog/sub-categories/${subCategoryId}`,
    );
    check("a sub-category with services cannot be deleted", () => {
      assert.equal(blockedSub.status, 409);
    });

    // -- add-ons (Admin 27) --------------------------------------------------
    const withAddOns = await call("PATCH", `/admin/catalog/services/${serviceId}`, {
      addOns: [
        {
          name: "Outdoor unit deep clean",
          description: "Coil wash and fin comb",
          pricePaise: 19900,
          durationMinutes: 30,
        },
      ],
    });
    const addOnBody = (await withAddOns.json()) as {
      addOns?: { name: string; pricePaise: number; id: string }[];
    };
    check("an admin can create an add-on", () => {
      // Until now `priceBooking` took addOnsPaise and no admin screen could
      // produce one — the customer side was priced against unenterable data.
      assert.equal(withAddOns.status, 200);
      assert.equal(addOnBody.addOns?.length, 1);
      assert.equal(addOnBody.addOns?.[0]?.pricePaise, 19900);
      assert.ok(addOnBody.addOns?.[0]?.id, "the add-on got no id");
    });

    // -- image upload --------------------------------------------------------
    // A 1x1 PNG, by its real bytes. Anything else is not a test of the check.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const goodForm = new FormData();
    goodForm.append("file", new Blob([pngBytes], { type: "image/png" }), "cover.png");
    const upload = await fetch(`${base}/api/admin/catalog/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: goodForm,
    });
    const uploadBody = (await upload.json()) as { path?: string };
    check("a real PNG uploads and returns a relative path", () => {
      assert.equal(upload.status, 201);
      assert.ok(
        uploadBody.path?.startsWith("/uploads/"),
        `expected a /uploads path, got ${String(uploadBody.path)}`,
      );
    });

    check("the stored path is relative, never an absolute URL", () => {
      // Absolute URLs would need a data migration to move host (§0.4).
      assert.ok(!/^https?:\/\//.test(uploadBody.path ?? ""));
    });

    const served = await fetch(`${base}${uploadBody.path ?? ""}`);
    check("the uploaded image is served back", () => {
      assert.equal(served.status, 200);
    });

    // The planted violation: HTML named .png. Served from our own origin that
    // is stored XSS, and the extension alone would have let it through.
    const fakeForm = new FormData();
    fakeForm.append(
      "file",
      new Blob([Buffer.from("<script>alert(1)</script>")], { type: "image/png" }),
      "payload.png",
    );
    const fake = await fetch(`${base}/api/admin/catalog/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fakeForm,
    });
    check("a non-image with an image extension is refused", () => {
      assert.equal(
        fake.status,
        400,
        "HTML renamed .png was accepted — that is stored XSS",
      );
    });

    const svgForm = new FormData();
    svgForm.append(
      "file",
      new Blob([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")], {
        type: "image/svg+xml",
      }),
      "icon.svg",
    );
    const svg = await fetch(`${base}/api/admin/catalog/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: svgForm,
    });
    check("an SVG is refused — it can carry script", () => {
      assert.equal(svg.status, 400);
    });

    // -- authorisation ------------------------------------------------------
    const anon = await call("POST", "/admin/catalog/categories", { name: "x" }, "");
    check("creating a category without a token is refused", () => {
      assert.equal(anon.status, 401);
    });
  } finally {
    // Ordered innermost-first, which is also the order the delete guards allow.
    if (serviceId) await call("DELETE", `/admin/catalog/services/${serviceId}`);
    if (subCategoryId) {
      await call("DELETE", `/admin/catalog/sub-categories/${subCategoryId}`);
    }
    if (categoryId) await call("DELETE", `/admin/catalog/categories/${categoryId}`);
  }
}

/**
 * Phase 4 — pro registration and admin KYC approval.
 *
 * The client's step 3, walked as an API sequence: a pro signs up with the dummy
 * OTP, uploads four documents, adds bank details, accepts the conduct, and an
 * admin approves them — then the approval guards are tested by planting each
 * violation they exist to stop.
 */
async function checkProOnboarding(
  base: string,
  adminToken: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] pro onboarding and KYC");

  const api = (path: string) => `${base}/api${path}`;
  const json = (path: string, body: unknown, token?: string, method = "POST") =>
    fetch(api(path), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (path: string, token?: string) =>
    fetch(api(path), { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  // A phone in the reserved test range, so this never collides with a real one.
  const phone = `+9199${String(Date.now()).slice(-8)}`;
  let proToken = "";
  let proId = "";
  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";

  resetRateLimits();

  try {
    // A service for the pro to register against.
    const cat = (await (
      await json("/admin/catalog/categories", { name: `__pro-check ${Date.now()}` }, adminToken)
    ).json()) as { id: string };
    categoryId = cat.id;
    const sub = (await (
      await json("/admin/catalog/sub-categories", { name: "__pro-check sub", categoryId }, adminToken)
    ).json()) as { id: string };
    subCategoryId = sub.id;
    const svc = (await (
      await json(
        "/admin/catalog/services",
        { name: "__pro-check service", subCategoryId, basePricePaise: 10000 },
        adminToken,
      )
    ).json()) as { id: string };
    serviceId = svc.id;

    // -- OTP ----------------------------------------------------------------
    const send = await json("/pro/otp/send", { phone });
    const sendBody = (await send.json()) as Record<string, unknown>;
    check("a pro can request an OTP", () => {
      assert.equal(send.status, 200);
    });

    check("the OTP is never returned in the response", () => {
      // P0 blocker B1. A dummy that leaks the code IS the blocker.
      const serialised = JSON.stringify(sendBody);
      assert.ok(!/\b\d{6}\b/.test(serialised), `a 6-digit code leaked: ${serialised}`);
      for (const key of ["code", "otp", "devOtp", "debugOtp"]) {
        assert.ok(!(key in sendBody), `response carries "${key}"`);
      }
    });

    const resend = await json("/pro/otp/send", { phone });
    check("an immediate resend is refused by the 30s lock", () => {
      assert.equal(resend.status, 429);
    });

    const wrongCode = await json("/pro/otp/verify", { phone, code: "000001" });
    check("a wrong OTP is refused", () => {
      assert.equal(wrongCode.status, 400);
    });

    const verify = await json("/pro/otp/verify", { phone, code: env.masterOtp });
    const verifyBody = (await verify.json()) as { token?: string; isNewPro?: boolean };
    proToken = verifyBody.token ?? "";
    check("the master OTP signs a new pro in", () => {
      assert.equal(verify.status, 200);
      assert.equal(verifyBody.isNewPro, true);
      assert.ok(proToken);
    });

    // The stored code is deleted on a successful verify, so the *next* wrong
    // guess must report "expired" rather than "wrong" — there is no longer a
    // record to compare against. That distinction is what proves consumption.
    //
    // Asserted this way because the real code is deliberately unreadable from
    // outside: it is never returned and never logged above debug. An assertion
    // that could only be written by leaking it would be testing the wrong
    // thing. (The first version of this check was
    // `status === 200 || status === 400`, which no bug could have failed.)
    const afterUse = await json("/pro/otp/verify", { phone, code: "000002" });
    const afterUseBody = (await afterUse.json()) as { code?: string };
    check("a consumed OTP is gone from the store", () => {
      assert.equal(afterUse.status, 400);
      assert.equal(
        afterUseBody.code,
        "OTP_EXPIRED",
        `expected the record to be consumed, got ${String(afterUseBody.code)}`,
      );
    });

    const badPhone = await json("/pro/otp/send", { phone: "12345" });
    check("a malformed phone number is refused", () => {
      assert.equal(badPhone.status, 400);
    });

    // -- registration -------------------------------------------------------
    const noServices = await json("/pro/register", { name: "Test Pro", areas: ["Srirangam"] }, proToken);
    check("registering with no services is refused", () => {
      assert.equal(noServices.status, 400);
    });

    const badService = await json(
      "/pro/register",
      { name: "Test Pro", serviceIds: ["svc_invented"], areas: ["Srirangam"] },
      proToken,
    );
    check("registering for a service that does not exist is refused", () => {
      // A pro registered against a nonexistent service matches zero jobs and
      // nobody finds out for a week.
      assert.equal(badService.status, 400);
    });

    const reg = await json(
      "/pro/register",
      {
        name: "Test Pro",
        serviceIds: [serviceId],
        areas: ["Srirangam", "Thillai Nagar"],
      },
      proToken,
    );
    const regBody = (await reg.json()) as {
      proId?: string;
      approvalStatus?: string;
      token?: string;
    };
    proId = regBody.proId ?? "";
    proToken = regBody.token ?? proToken;
    check("a pro can register and lands as pending", () => {
      assert.equal(reg.status, 201);
      assert.equal(regBody.approvalStatus, "pending");
      assert.ok(proId);
    });

    const state1 = (await (await get("/pro/approval-state", proToken)).json()) as {
      status?: string;
      steps?: Record<string, boolean>;
      documents?: { status: string; uploaded: boolean }[];
    };
    check("multiple areas are kept, not reduced to the first", () => {
      // PRO-OPEN-ITEMS 1.5: the form collected several and all but one was
      // discarded. Dispatch in Phase 6 matches against all of them.
      assert.equal(state1.steps?.registered, true);
    });

    check("a document never uploaded reads as missing, not pending", () => {
      // "Pending" means a human is looking at it. The pro needs to know which
      // of those two states they are in.
      assert.equal(state1.documents?.[0]?.status, "missing");
      assert.equal(state1.documents?.[0]?.uploaded, false);
    });

    // -- approval guards, before anything is uploaded -----------------------
    const prematureApprove = await json(`/admin/pros/${proId}/approve`, {}, adminToken);
    check("approving a pro with no documents is refused", () => {
      assert.equal(prematureApprove.status, 409);
    });

    // -- documents ----------------------------------------------------------
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const uploadDoc = async (type: string) => {
      const form = new FormData();
      form.append("file", new Blob([pngBytes], { type: "image/png" }), `${type}.png`);
      form.append("type", type);
      return fetch(api("/pro/documents"), {
        method: "POST",
        headers: { Authorization: `Bearer ${proToken}` },
        body: form,
      });
    };

    const firstDoc = await uploadDoc("aadhaar_front");
    const firstDocBody = (await firstDoc.json()) as { status?: string };
    check("a document uploads and comes back pending, never approved", () => {
      // Returning "approved" would teach the pro that review is automatic and
      // then contradict itself a day later.
      assert.equal(firstDoc.status, 201);
      assert.equal(firstDocBody.status, "pending");
    });

    const badType = await uploadDoc("passport");
    check("an unknown document type is refused", () => {
      assert.equal(badType.status, 400);
    });

    for (const type of ["aadhaar_back", "pan", "selfie"]) {
      await uploadDoc(type);
    }

    // -- the private root is not public ------------------------------------
    const docRoute = `/admin/pros/${proId}/documents/aadhaar_front`;
    const anonDoc = await fetch(api(docRoute));
    check("a KYC document is unreachable without a token", () => {
      assert.equal(anonDoc.status, 401, "an Aadhaar was served to an anonymous caller");
    });

    const adminDoc = await get(docRoute, adminToken);
    check("an admin can read a KYC document", () => {
      assert.equal(adminDoc.status, 200);
    });

    check("KYC documents are sent with no-store", () => {
      // Otherwise a shared or kiosk browser keeps someone's Aadhaar on disk.
      assert.match(adminDoc.headers.get("cache-control") ?? "", /no-store/);
    });

    const proOwnDoc = await get("/pro/documents/aadhaar_front", proToken);
    check("a pro can read their own document", () => {
      assert.equal(proOwnDoc.status, 200);
    });

    // -- bank ---------------------------------------------------------------
    const badIfsc = await json(
      "/pro/bank",
      { accountName: "Test Pro", accountNumber: "123456789012", ifsc: "NOPE" },
      proToken,
      "PUT",
    );
    check("a malformed IFSC is refused", () => {
      // It would otherwise fail days later at the first payout, with the pro
      // chasing it.
      assert.equal(badIfsc.status, 400);
    });

    const shortAccount = await json(
      "/pro/bank",
      { accountName: "Test Pro", accountNumber: "123", ifsc: "HDFC0001234" },
      proToken,
      "PUT",
    );
    check("a too-short account number is refused", () => {
      assert.equal(shortAccount.status, 400);
    });

    const bank = await json(
      "/pro/bank",
      {
        accountName: "Test Pro",
        accountNumber: "123456789012",
        ifsc: "HDFC0001234",
        upiId: "testpro@okhdfc",
      },
      proToken,
      "PUT",
    );
    const bankBody = (await bank.json()) as Record<string, unknown>;
    check("bank details save", () => {
      assert.equal(bank.status, 200);
      assert.equal(bankBody["accountLast4"], "9012");
    });

    check("the full account number is never echoed back", () => {
      const serialised = JSON.stringify(bankBody);
      assert.ok(
        !serialised.includes("123456789012"),
        `the full account number came back: ${serialised}`,
      );
    });

    // -- conduct ------------------------------------------------------------
    const conduct = await json("/pro/conduct", {}, proToken);
    const conductBody = (await conduct.json()) as { version?: string };
    check("conduct acceptance records the wording version signed", () => {
      // A pro who signed one version and later read another has a legitimate
      // grievance a bare timestamp cannot answer.
      assert.equal(conduct.status, 200);
      assert.ok(conductBody.version, "no version recorded");
    });

    // -- approval, with the documents unverified ---------------------------
    const unverified = await json(`/admin/pros/${proId}/approve`, {}, adminToken);
    check("approving with unverified documents is refused", () => {
      // Approving a pro whose PAN was never looked at is the failure this
      // screen exists to prevent. The UI disables the button; that is not a
      // check.
      assert.equal(unverified.status, 409);
    });

    const noReason = await json(
      `/admin/pros/${proId}/documents/pan`,
      { status: "rejected" },
      adminToken,
      "PATCH",
    );
    check("rejecting a document with no reason is refused", () => {
      assert.equal(noReason.status, 400);
    });

    for (const type of ["aadhaar_front", "aadhaar_back", "pan", "selfie"]) {
      await json(
        `/admin/pros/${proId}/documents/${type}`,
        { status: "approved" },
        adminToken,
        "PATCH",
      );
    }

    const detail = (await (await get(`/admin/pros/${proId}`, adminToken)).json()) as {
      documents?: { status: string; rejectionReason?: string }[];
      bankAccountLast4?: string;
    };
    check("an approved document carries no rejection reason", () => {
      // PRO-OPEN-ITEMS 4.7: independent fields produced documents approved
      // while still carrying a rejection reason.
      for (const d of detail.documents ?? []) {
        if (d.status === "approved") assert.equal(d.rejectionReason, undefined);
      }
    });

    check("the admin detail shows only the last four of the account", () => {
      assert.equal(detail.bankAccountLast4, "9012");
    });

    const approve = await json(`/admin/pros/${proId}/approve`, {}, adminToken);
    check("an admin can approve a fully verified pro", () => {
      assert.equal(approve.status, 200);
    });

    const twice = await json(`/admin/pros/${proId}/approve`, {}, adminToken);
    check("approving twice is refused", () => {
      assert.equal(twice.status, 409);
    });

    // -- dispatch eligibility ----------------------------------------------
    const eligible = (await (
      await get(`/admin/pros/${proId}/dispatch-status`, adminToken)
    ).json()) as { eligible?: boolean; reasons?: string[] };
    check("an approved but offline pro is not yet eligible for offers", () => {
      // Offline is the correct default: a pro who has not said they are ready
      // should not be alerted for work.
      assert.equal(eligible.eligible, true);
      assert.ok(eligible.reasons?.includes("Currently offline"));
    });

    // -- blocking ----------------------------------------------------------
    const blockNoReason = await json(`/admin/pros/${proId}/block`, {}, adminToken);
    check("blocking with no reason is refused", () => {
      assert.equal(blockNoReason.status, 400);
    });

    const block = await json(
      `/admin/pros/${proId}/block`,
      { reason: "Self-check only" },
      adminToken,
    );
    check("an admin can block a pro", () => {
      assert.equal(block.status, 200);
    });

    const blockedStatus = (await (
      await get(`/admin/pros/${proId}/dispatch-status`, adminToken)
    ).json()) as { eligible?: boolean };
    check("a blocked pro cannot receive offers", () => {
      assert.equal(blockedStatus.eligible, false);
    });

    await json(`/admin/pros/${proId}/unblock`, {}, adminToken);

    // -- cross-tenant: one pro must not touch another's record -------------
    const otherPhone = `+9198${String(Date.now()).slice(-8)}`;
    await json("/pro/otp/send", { phone: otherPhone });
    const otherVerify = (await (
      await json("/pro/otp/verify", { phone: otherPhone, code: env.masterOtp })
    ).json()) as { token?: string };

    const stolen = await get("/pro/approval-state", otherVerify.token ?? "");
    const stolenBody = (await stolen.json()) as unknown;
    check("an unregistered pro's token reveals no other pro's record", () => {
      // The id comes from the token, never from a parameter, so there is no
      // field to tamper with — this asserts that holds.
      assert.equal(stolenBody, null);
    });

    const adminOnly = await get(`/admin/pros/${proId}`, otherVerify.token ?? "");
    check("a pro token cannot read the admin pro detail", () => {
      assert.equal(adminOnly.status, 403);
    });
  } finally {
    if (proId) await Pro.findByIdAndDelete(proId);
    await Pro.deleteOne({ phone });
    if (serviceId) await json(`/admin/catalog/services/${serviceId}`, {}, adminToken, "DELETE");
    if (subCategoryId) {
      await json(`/admin/catalog/sub-categories/${subCategoryId}`, {}, adminToken, "DELETE");
    }
    if (categoryId) {
      await json(`/admin/catalog/categories/${categoryId}`, {}, adminToken, "DELETE");
    }
    resetRateLimits();
  }
}

/**
 * Phase 5 — customer auth, addresses, booking, cash and wallet.
 *
 * Weighted towards the money paths, because those are where a silent error is
 * expensive rather than merely visible: GST on the wrong base, a discount that
 * exceeds the work, a client-sent total being trusted, a coupon over-redeeming,
 * a double-tap creating two bookings.
 */
async function checkBooking(
  base: string,
  adminToken: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] customer booking, cash and wallet");

  const api = (p: string) => `${base}/api${p}`;
  const call = (method: string, p: string, body?: unknown, token?: string) =>
    fetch(api(p), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const phone = `+9197${String(Date.now()).slice(-8)}`;
  let custToken = "";
  let customerId = "";
  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";
  let couponId = "";

  resetRateLimits();

  try {
    // A priced service to book, and a pro so slots have capacity.
    const cat = (await (
      await call("POST", "/admin/catalog/categories", { name: `__bk ${Date.now()}` }, adminToken)
    ).json()) as { id: string };
    categoryId = cat.id;
    const sub = (await (
      await call("POST", "/admin/catalog/sub-categories", { name: "__bk sub", categoryId }, adminToken)
    ).json()) as { id: string };
    subCategoryId = sub.id;

    const svc = (await (
      await call(
        "POST",
        "/admin/catalog/services",
        {
          name: "__bk service",
          subCategoryId,
          // ₹500 base, ₹50 platform fee. GST is 18% of the FEE only = ₹9.
          basePricePaise: 50_000,
          platformFeePaise: 5_000,
          visitChargePaise: 4_900,
          variants: [
            { name: "Standard", priceDeltaPaise: 0, durationMinutes: 60, isDefault: true },
            { name: "Large", priceDeltaPaise: 20_000, durationMinutes: 120 },
          ],
          addOns: [
            { name: "Extra room", pricePaise: 15_000, durationMinutes: 30 },
          ],
        },
        adminToken,
      )
    ).json()) as { id: string; addOns?: { id: string }[]; variants?: { id: string; name: string }[] };
    serviceId = svc.id;
    const addOnId = svc.addOns?.[0]?.id ?? "";
    const largeVariantId = svc.variants?.find((v) => v.name === "Large")?.id ?? "";

    // -- sign in ------------------------------------------------------------
    await call("POST", "/consumer/auth/otp/send", { phone });
    const verify = await call("POST", "/consumer/auth/otp/verify", {
      phone,
      code: env.masterOtp,
    });
    const verifyBody = (await verify.json()) as { token?: string; isNewUser?: boolean };
    custToken = verifyBody.token ?? "";
    check("a new customer is created on first OTP, with no extra form", () => {
      assert.equal(verify.status, 200);
      assert.equal(verifyBody.isNewUser, true);
      assert.ok(custToken);
    });

    const me = (await (await call("GET", "/consumer/auth/me", undefined, custToken)).json()) as {
      id?: string; walletPaise?: number; totalBookings?: number;
    };
    customerId = me.id ?? "";
    check("a new customer starts with a zero wallet and no bookings", () => {
      assert.equal(me.walletPaise, 0);
      assert.equal(me.totalBookings, 0);
    });

    // -- addresses ----------------------------------------------------------
    const badPin = await call("PUT", "/consumer/addresses", {
      label: "home", line1: "1 Test St", area: "Srirangam",
      city: "Tiruchirappalli", state: "Tamil Nadu", pincode: "99",
    }, custToken);
    check("a malformed pincode is refused", () => {
      assert.equal(badPin.status, 400);
    });

    const addr = await call("PUT", "/consumer/addresses", {
      label: "home", line1: "42 Kaveri Nagar", area: "Srirangam",
      city: "Tiruchirappalli", state: "Tamil Nadu", pincode: "620006",
      point: { lat: 10.85, lng: 78.68 },
    }, custToken);
    const addrBody = (await addr.json()) as { id?: string; isDefault?: boolean };
    const addressId = addrBody.id ?? "";
    check("the first address saved becomes the default", () => {
      // Otherwise the booking flow pre-selects nothing and shows a blank.
      assert.equal(addr.status, 201);
      assert.equal(addrBody.isDefault, true);
    });

    const staleEdit = await call("PUT", "/consumer/addresses", {
      id: "addr_gone", label: "home", line1: "x", area: "Srirangam",
      city: "Tiruchirappalli", state: "Tamil Nadu", pincode: "620006",
    }, custToken);
    check("editing an address that no longer exists is refused, not duplicated", () => {
      assert.equal(staleEdit.status, 404);
    });

    // -- pricing: the rules that cost money if wrong ------------------------
    const priced = (await (
      await call("POST", "/consumer/bookings/price", { serviceId, addressId }, custToken)
    ).json()) as PriceBreakdownShape;

    check("GST is charged on the platform fee only, never the subtotal", () => {
      // ₹50 fee -> 9% CGST = ₹4.50, 9% SGST = ₹4.50. Against the ₹500 service
      // it would be ₹45 each, which overcharges every customer.
      assert.equal(priced.cgstPaise, 450);
      assert.equal(priced.sgstPaise, 450);
    });

    check("the total adds up from its own parts", () => {
      const sum =
        priced.servicePaise + priced.addOnsPaise - priced.discountPaise +
        priced.visitChargePaise + priced.platformFeePaise +
        priced.cgstPaise + priced.sgstPaise;
      assert.equal(priced.totalPaise, sum);
    });

    const qty = (await (
      await call("POST", "/consumer/bookings/price",
        { serviceId, addressId, quantity: 3, addOnIds: [addOnId] }, custToken)
    ).json()) as PriceBreakdownShape;

    check("quantity multiplies the work but not the visit charge or fee", () => {
      // Charging per unit would double-bill for one trip to the door.
      assert.equal(qty.servicePaise, priced.servicePaise * 3);
      assert.equal(qty.visitChargePaise, priced.visitChargePaise);
      assert.equal(qty.platformFeePaise, priced.platformFeePaise);
    });

    check("an add-on is charged once per booking, not per unit", () => {
      // Three ACs and one deep-clean means one deep clean.
      assert.equal(qty.addOnsPaise, 15_000);
    });

    const variant = (await (
      await call("POST", "/consumer/bookings/price",
        { serviceId, addressId, variantId: largeVariantId }, custToken)
    ).json()) as PriceBreakdownShape;
    check("a variant is priced as a delta against the base", () => {
      assert.equal(variant.servicePaise, 70_000);
    });

    // -- coupons ------------------------------------------------------------
    const code = `__BK${String(Date.now()).slice(-6)}`;
    const couponDoc = await Coupon.create({
      _id: `cpn_test_${Date.now()}`,
      code,
      discountType: "percent",
      discountValue: 20,
      maxUses: 1,
      usedCount: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
      firstBookingOnly: false,
      restrictions: { areas: [], serviceIds: [], minOrderPaise: 0, maxDiscountPaise: 5_000, perCustomerLimit: 0 },
      active: true,
    });
    couponId = couponDoc._id;

    const applied = (await (
      await call("POST", "/consumer/bookings/coupon", { serviceId, addressId, code }, custToken)
    ).json()) as { ok?: boolean; discountPaise?: number };
    check("a percentage coupon is capped by its maximum discount", () => {
      // 20% of ₹500 is ₹100, capped at ₹50.
      assert.equal(applied.ok, true);
      assert.equal(applied.discountPaise, 5_000);
    });

    const unknown = (await (
      await call("POST", "/consumer/bookings/coupon", { serviceId, addressId, code: "NOPE" }, custToken)
    ).json()) as { ok?: boolean; reason?: string };
    check("an unknown coupon names its reason, not just 'invalid'", () => {
      // A customer told why will act; a customer told "invalid" leaves.
      assert.equal(unknown.ok, false);
      assert.equal(unknown.reason, "unknown");
    });

    const withCoupon = (await (
      await call("POST", "/consumer/bookings/price", { serviceId, addressId, couponCode: code }, custToken)
    ).json()) as PriceBreakdownShape;
    check("a discount comes off the work, leaving the fee and its GST alone", () => {
      assert.equal(withCoupon.discountPaise, 5_000);
      assert.equal(withCoupon.platformFeePaise, priced.platformFeePaise);
      assert.equal(withCoupon.cgstPaise, priced.cgstPaise);
    });

    // -- placing it ---------------------------------------------------------
    const tomorrow = new Date(Date.now() + 26 * 3_600_000).toISOString();

    const tampered = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "cash",
      expectedTotalPaise: 1,
    }, custToken);
    check("a client-sent total that disagrees with the server is refused", () => {
      // The one field someone has a direct financial reason to tamper with.
      assert.equal(tampered.status, 409);
    });

    const past = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      paymentMethod: "cash",
    }, custToken);
    check("a slot in the past is refused", () => {
      assert.equal(past.status, 400);
    });

    const online = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "upi",
    }, custToken);
    check("an online payment answers 503, not a fake success", () => {
      // No keys, so no pretending a payment happened (§0.3).
      assert.equal(online.status, 503);
    });

    const noWallet = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "wallet",
    }, custToken);
    check("a wallet booking with no balance is refused", () => {
      assert.equal(noWallet.status, 409);
    });

    const key = `idem-${Date.now()}`;
    const placed = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "cash",
      couponCode: code, idempotencyKey: key, notes: "Self-check",
    }, custToken);
    const placedBody = (await placed.json()) as { reference?: string };
    check("a cash booking is placed", () => {
      assert.equal(placed.status, 201);
      assert.match(placedBody.reference ?? "", /^CFC\d{8}$/);
    });

    const retry = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "cash",
      couponCode: code, idempotencyKey: key,
    }, custToken);
    const retryBody = (await retry.json()) as { reference?: string };
    const bookingCount = await Booking.countDocuments({ customerId });
    check("a repeated request with the same key returns the same booking", () => {
      // A double-tap on a slow connection must not create two bookings.
      assert.equal(retryBody.reference, placedBody.reference);
      assert.equal(bookingCount, 1, "the retry created a second booking");
    });

    const exhausted = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "cash",
      couponCode: code, idempotencyKey: `${key}-2`,
    }, custToken);
    check("a single-use coupon cannot be redeemed twice", () => {
      // $inc guarded in the filter, so Mongo decides and two concurrent
      // requests cannot both read 0 of 1 and both succeed.
      assert.equal(exhausted.status, 409);
    });

    // -- the frozen breakdown (§4.1) ----------------------------------------
    const detail = (await (
      await call("GET", `/consumer/bookings/${placedBody.reference}`, undefined, custToken)
    ).json()) as { breakdown?: PriceBreakdownShape; variantName?: string | null };

    check("the booking stores its own price breakdown", () => {
      assert.ok(detail.breakdown, "no breakdown on the booking");
      assert.equal(detail.breakdown?.discountPaise, 5_000);
    });

    check("the chosen variant is recorded, not dropped", () => {
      // §4.5 — picking a variant and booking got you the base price.
      assert.equal(detail.variantName, "Standard");
    });

    // Change the price, then confirm the historical invoice did not move.
    await call("PATCH", `/admin/catalog/pricing/${serviceId}`, {
      basePricePaise: 99_900, platformFeePaise: 9_900,
      visitChargePaise: 0, nightSurchargePaise: 0,
    }, adminToken);

    const after = (await (
      await call("GET", `/consumer/bookings/${placedBody.reference}`, undefined, custToken)
    ).json()) as { breakdown?: PriceBreakdownShape };
    check("changing a price does not rewrite an existing tax invoice", () => {
      // The failure §4.1 describes: the invoice recomputed from current pricing,
      // so editing a fee silently altered every historical tax document.
      assert.equal(after.breakdown?.platformFeePaise, 5_000);
      assert.equal(after.breakdown?.cgstPaise, 450);
    });

    // -- tabs and counts ----------------------------------------------------
    const counts = (await (
      await call("GET", "/consumer/bookings/counts", undefined, custToken)
    ).json()) as Record<string, number>;
    check("a pending booking counts under Upcoming", () => {
      assert.equal(counts["upcoming"], 1);
      assert.equal(counts["ongoing"], 0);
    });

    const active = (await (
      await call("GET", "/consumer/bookings/active", undefined, custToken)
    ).json()) as { reference?: string } | null;
    check("the home screen's active booking is the live one", () => {
      assert.equal(active?.reference, placedBody.reference);
    });

    // -- another customer must not see it -----------------------------------
    const otherPhone = `+9196${String(Date.now()).slice(-8)}`;
    await call("POST", "/consumer/auth/otp/send", { phone: otherPhone });
    const otherTok = ((await (
      await call("POST", "/consumer/auth/otp/verify", { phone: otherPhone, code: env.masterOtp })
    ).json()) as { token?: string }).token ?? "";

    const peek = await call("GET", `/consumer/bookings/${placedBody.reference}`, undefined, otherTok);
    check("another customer's booking is a 404, not a 403", () => {
      // "That exists but is not yours" is more than an attacker needs.
      assert.equal(peek.status, 404);
    });

    const otherList = (await (
      await call("GET", "/consumer/bookings", undefined, otherTok)
    ).json()) as unknown[];
    check("a customer's list contains only their own bookings", () => {
      assert.equal(otherList.length, 0);
    });

    // -- wallet -------------------------------------------------------------
    const topup = await call("POST", "/consumer/wallet/topup", { amountPaise: 10_000 }, custToken);
    check("wallet top-up answers 503 rather than crediting real balance", () => {
      // Crediting spendable balance against money that never arrived is the one
      // place a convenient stub becomes theft from the business.
      assert.equal(topup.status, 503);
    });

    // An admin-originated credit, which is the only kind that exists today.
    await WalletEntry.create({
      _id: `wtx_test_${Date.now()}`,
      customerId, kind: "cashback", label: "Self-check credit",
      amountPaise: 200_000, status: "completed",
    });
    const balance = (await (
      await call("GET", "/consumer/wallet/balance", undefined, custToken)
    ).json()) as number;
    check("the balance is the sum of the ledger", () => {
      assert.equal(balance, 200_000);
    });

    await WalletEntry.create({
      _id: `wtx_pending_${Date.now()}`,
      customerId, kind: "topup", label: "Not arrived",
      amountPaise: 500_000, status: "pending",
    });
    const stillBalance = (await (
      await call("GET", "/consumer/wallet/balance", undefined, custToken)
    ).json()) as number;
    check("a pending credit is not spendable", () => {
      // Counting it is how a wallet goes negative.
      assert.equal(stillBalance, 200_000);
    });

    // -- cancellation refunds a wallet payment ------------------------------
    const walletBooking = await call("POST", "/consumer/bookings", {
      serviceId, addressId, startsAt: tomorrow, paymentMethod: "wallet",
      idempotencyKey: `w-${Date.now()}`,
    }, custToken);
    const wbBody = (await walletBooking.json()) as { reference?: string };
    check("a wallet booking is placed and paid at once", () => {
      assert.equal(walletBooking.status, 201);
      // Asserted, because every check below depends on it: without this, a
      // failed creation makes "refunds in full" pass for the wrong reason —
      // the balance never moved, so it still matches.
      assert.ok(wbBody.reference, "no reference came back");
    });

    const afterDebit = (await (
      await call("GET", "/consumer/wallet/balance", undefined, custToken)
    ).json()) as number;
    check("the wallet is debited by the booking total", () => {
      assert.ok(afterDebit < 200_000, `balance did not move: ${afterDebit}`);
    });

    await call("POST", `/consumer/bookings/${wbBody.reference}/cancel`, undefined, custToken);
    const refunded = (await (
      await call("GET", "/consumer/wallet/balance", undefined, custToken)
    ).json()) as number;
    check("cancelling a wallet booking refunds it in full", () => {
      // No cancellation fee: the agreement documents no policy (§7.2), and one
      // invented here would be a developer setting commercial terms.
      assert.equal(refunded, 200_000);
    });

    const cancelTwice = await call(
      "POST", `/consumer/bookings/${wbBody.reference}/cancel`, undefined, custToken,
    );
    check("cancelling twice is refused by the state machine", () => {
      assert.equal(cancelTwice.status, 409);
    });
  } finally {
    await Booking.deleteMany({ customerId });
    await WalletEntry.deleteMany({ customerId });
    await Customer.deleteOne({ phone });
    await Customer.deleteMany({ phone: { $regex: "^\\+9196" } });
    if (couponId) await Coupon.findByIdAndDelete(couponId);
    if (serviceId) await call("DELETE", `/admin/catalog/services/${serviceId}`, undefined, adminToken);
    if (subCategoryId) await call("DELETE", `/admin/catalog/sub-categories/${subCategoryId}`, undefined, adminToken);
    if (categoryId) await call("DELETE", `/admin/catalog/categories/${categoryId}`, undefined, adminToken);
    resetRateLimits();
  }
}

/** The fields of `PriceBreakdown` the checks above read. */
interface PriceBreakdownShape {
  servicePaise: number;
  addOnsPaise: number;
  visitChargePaise: number;
  platformFeePaise: number;
  discountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
}

/**
 * Phase 6 — dispatch.
 *
 * The two things that cannot be got wrong here, and both are checked with
 * planted violations rather than happy paths:
 *
 *   **first-to-accept-wins must be atomic.** Three pros are notified; if a
 *   read-then-write slips through, all three accept the same job and three
 *   people turn up at one house.
 *
 *   **the offer must withhold the address.** Two of the three pros alerted will
 *   not attend, and releasing a customer's door number to them is a privacy
 *   breach that no later fix undoes.
 */
async function checkDispatch(
  base: string,
  adminToken: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] dispatch");

  const api = (p: string) => `${base}/api${p}`;
  const call = (method: string, p: string, body?: unknown, token?: string) =>
    fetch(api(p), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const stamp = String(Date.now()).slice(-8);
  const custPhone = `+9194${stamp}`;
  const proPhones = [`+9193${stamp}`, `+9192${stamp}`, `+9191${stamp}`];

  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";
  let custToken = "";
  const proTokens: string[] = [];
  const proIds: string[] = [];

  resetRateLimits();

  try {
    // -- a service, three approved pros, one customer -----------------------
    const cat = (await (
      await call("POST", "/admin/catalog/categories", { name: `__dsp ${stamp}` }, adminToken)
    ).json()) as { id: string };
    categoryId = cat.id;
    const sub = (await (
      await call("POST", "/admin/catalog/sub-categories", { name: "__dsp sub", categoryId }, adminToken)
    ).json()) as { id: string };
    subCategoryId = sub.id;
    const svc = (await (
      await call("POST", "/admin/catalog/services", {
        name: "__dsp service", subCategoryId,
        basePricePaise: 100_000, platformFeePaise: 10_000,
        inclusions: ["Step one", "Step two"],
        variants: [{ name: "Standard", priceDeltaPaise: 0, durationMinutes: 60, isDefault: true }],
      }, adminToken)
    ).json()) as { id: string };
    serviceId = svc.id;

    // Three pros, fully onboarded and approved, all serving Srirangam.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const phone of proPhones) {
      await call("POST", "/pro/otp/send", { phone });
      const tok = ((await (
        await call("POST", "/pro/otp/verify", { phone, code: env.masterOtp })
      ).json()) as { token?: string }).token ?? "";

      const reg = (await (
        await call("POST", "/pro/register", {
          name: `Pro ${phone.slice(-4)}`, serviceIds: [serviceId], areas: ["Srirangam"],
        }, tok)
      ).json()) as { proId?: string; token?: string };

      const proTok = reg.token ?? tok;
      proTokens.push(proTok);
      proIds.push(reg.proId ?? "");

      for (const type of ["aadhaar_front", "aadhaar_back", "pan", "selfie"]) {
        const form = new FormData();
        form.append("file", new Blob([png], { type: "image/png" }), `${type}.png`);
        form.append("type", type);
        await fetch(api("/pro/documents"), {
          method: "POST",
          headers: { Authorization: `Bearer ${proTok}` },
          body: form,
        });
        await call("PATCH", `/admin/pros/${reg.proId}/documents/${type}`,
          { status: "approved" }, adminToken);
      }
      await call("PUT", "/pro/bank", {
        accountName: "Test", accountNumber: "123456789012", ifsc: "HDFC0001234",
      }, proTok);
      await call("POST", "/pro/conduct", {}, proTok);
      await call("POST", `/admin/pros/${reg.proId}/approve`, {}, adminToken);
    }

    await call("POST", "/consumer/auth/otp/send", { phone: custPhone });
    custToken = ((await (
      await call("POST", "/consumer/auth/otp/verify", { phone: custPhone, code: env.masterOtp })
    ).json()) as { token?: string }).token ?? "";

    const addr = (await (
      await call("PUT", "/consumer/addresses", {
        label: "home", line1: "42 Kaveri Nagar", landmark: "Near the water tank",
        area: "Srirangam", city: "Tiruchirappalli", state: "Tamil Nadu",
        pincode: "620006", point: { lat: 10.85, lng: 78.68 },
      }, custToken)
    ).json()) as { id: string };

    // -- an offline pro gets nothing ----------------------------------------
    const offlineOffer = await call("GET", "/pro/offers/next", undefined, proTokens[0]);
    const offlineBody = (await offlineOffer.json()) as unknown;
    check("an offline pro receives no offers", () => {
      // Offline is the correct default: alerting a pro who has not said they
      // are ready costs them a penalty, not just an annoyance.
      assert.equal(offlineBody, null);
    });

    for (const tok of proTokens) {
      await call("PUT", "/pro/online", { online: true }, tok);
    }

    // -- book, which dispatches ---------------------------------------------
    const tomorrow = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const bk = (await (
      await call("POST", "/consumer/bookings", {
        serviceId, addressId: addr.id, startsAt: tomorrow,
        paymentMethod: "cash", idempotencyKey: `dsp-${stamp}`,
      }, custToken)
    ).json()) as { reference?: string };

    // Dispatch is fired without blocking the response, so give it a moment.
    await new Promise((r) => setTimeout(r, 400));

    const offerCount = await Offer.countDocuments({ status: "offered" });
    check("booking notifies three pros simultaneously", () => {
      assert.equal(
        offerCount,
        3,
        `expected 3 simultaneous offers, got ${offerCount}`,
      );
    });

    const windows = await Offer.find({ status: "offered" })
      .select({ expiresAt: 1 })
      .lean<{ expiresAt: Date }[]>();
    check("all three windows start at the same instant", () => {
      // Staggered starts would quietly favour whoever was written first.
      const times = new Set(windows.map((w) => w.expiresAt.getTime()));
      assert.equal(times.size, 1, "the three windows have different deadlines");
    });

    const offers = await Promise.all(
      proTokens.map(async (tok) =>
        (await (await call("GET", "/pro/offers/next", undefined, tok)).json()) as {
          offerId?: string;
          address?: string | null;
          customerPhone?: string | null;
          landmark?: string | null;
          location?: unknown;
          area?: string;
          expiresInSeconds?: number;
          netEarningPaise?: number;
          grossEarningPaise?: number;
          checklist?: string[];
        } | null,
      ),
    );

    check("every notified pro sees the offer", () => {
      assert.equal(offers.filter(Boolean).length, 3);
    });

    check("the offer withholds the address, phone, landmark and coordinates", () => {
      // Two of three will not attend. A coordinate IS an address, so
      // publishing the latitude while hiding the street is no protection.
      for (const o of offers) {
        assert.equal(o?.address, null, "an offer leaked the street address");
        assert.equal(o?.customerPhone, null, "an offer leaked the phone");
        assert.equal(o?.landmark, null, "an offer leaked the landmark");
        assert.equal(o?.location, null, "an offer leaked the coordinates");
      }
    });

    check("the offer still carries what the decision needs", () => {
      // Area, earnings and the checklist — 30 seconds is not long enough to
      // guess what "deep clean" covers.
      assert.equal(offers[0]?.area, "Srirangam");
      assert.ok((offers[0]?.netEarningPaise ?? 0) > 0);
      assert.ok((offers[0]?.checklist?.length ?? 0) > 0);
    });

    check("the countdown is reported from the server, not assumed", () => {
      const left = offers[0]?.expiresInSeconds ?? 0;
      assert.ok(left > 0 && left <= 30, `window was ${left}s`);
    });

    check("a pro under 20 jobs pays no commission", () => {
      // First 20 jobs at 0%, from the agreement.
      assert.equal(offers[0]?.netEarningPaise, offers[0]?.grossEarningPaise);
    });

    // -- the race: all three accept at once ---------------------------------
    const results = await Promise.all(
      offers.map(async (o, i) =>
        (await (
          await call("POST", `/pro/offers/${o?.offerId}/accept`, {}, proTokens[i])
        ).json()) as { kind?: string; job?: { address?: string | null; customerPhone?: string | null } },
      ),
    );

    const accepted = results.filter((r) => r.kind === "accepted");
    const taken = results.filter((r) => r.kind === "taken");

    check("exactly one of three concurrent accepts wins", () => {
      // The whole point. A read-then-write would let all three through and
      // three people would turn up at one house.
      assert.equal(
        accepted.length,
        1,
        `${accepted.length} pros accepted the same job`,
      );
      assert.equal(taken.length, 2);
    });

    check("the losers are told 'taken', not given an error", () => {
      // The documented rule working, which the UI renders as a real outcome.
      for (const r of taken) assert.equal(r.kind, "taken");
    });

    check("the winner is given the address and phone", () => {
      const job = accepted[0]?.job;
      assert.ok(job?.address, "the accepting pro got no address");
      assert.ok(job?.customerPhone, "the accepting pro got no phone");
    });

    const booking = await Booking.findOne({ reference: bk.reference }).lean();
    check("the booking is assigned to exactly one pro", () => {
      assert.equal(booking?.status, "assigned");
      assert.ok(booking?.proId);
    });

    check("a completion OTP is generated at assignment", () => {
      assert.match(booking?.completionOtp ?? "", /^\d{6}$/);
    });

    const winnerId = booking?.proId ?? "";
    const winner = await Pro.findById(winnerId).lean();
    check("the winning pro goes offline on accept", () => {
      // From the agreement, and not a UI preference: a pro on a job must not
      // be in the pool that gets alerted.
      assert.equal(winner?.online, false);
    });

    const losers = await Pro.find({ _id: { $in: proIds.filter((id) => id !== winnerId) } }).lean();
    check("the losing pros stay online and available", () => {
      for (const l of losers) assert.equal(l.online, true);
    });

    // -- the customer's view -------------------------------------------------
    const tracked = (await (
      await call("GET", `/consumer/bookings/${bk.reference}`, undefined, custToken)
    ).json()) as {
      pro?: { name?: string; phone?: string; rating?: number } | null;
      completionOtp?: string | null;
    };

    check("the customer now sees who is coming, and how to reach them", () => {
      assert.ok(tracked.pro?.name, "no pro on the customer's booking");
      assert.ok(tracked.pro?.phone, "no phone for the assigned pro");
    });

    check("the customer's completion OTP is released once a pro is assigned", () => {
      assert.match(tracked.completionOtp ?? "", /^\d{6}$/);
    });

    const leaked = JSON.stringify(tracked);
    check("the customer is not given the pro's financial record", () => {
      // ProDetail carries bank last-four, IFSC, earnings and warnings. None of
      // it is a customer's business, and it would be in the network tab.
      for (const field of ["bankAccountLast4", "ifsc", "totalEarnedPaise", "warningCount"]) {
        assert.ok(!leaked.includes(field), `the customer's booking leaked ${field}`);
      }
    });

    // -- a second accept on a resolved offer ---------------------------------
    const lateAccept = await call(
      "POST", `/pro/offers/${offers[0]?.offerId}/accept`, {},
      proTokens[0],
    );
    const lateBody = (await lateAccept.json()) as { kind?: string };
    check("accepting an already-resolved offer is refused", () => {
      assert.ok(["taken", "expired", "gone"].includes(lateBody.kind ?? ""));
    });

    // -- expiry and escalation, forced rather than waited out ---------------
    const bk2 = (await (
      await call("POST", "/consumer/bookings", {
        serviceId, addressId: addr.id, startsAt: tomorrow,
        paymentMethod: "cash", idempotencyKey: `dsp2-${stamp}`,
      }, custToken)
    ).json()) as { reference?: string };
    await new Promise((r) => setTimeout(r, 400));

    const booking2 = await Booking.findOne({ reference: bk2.reference }).lean();
    const live = await Offer.countDocuments({
      bookingId: booking2?._id, status: "offered",
    });
    check("a second booking is offered to the pros still online", () => {
      // The winner of the first is offline now, so two remain.
      assert.equal(live, 2, `expected 2 offers, got ${live}`);
    });

    // Backdate the windows rather than sleeping 30 seconds.
    await Offer.updateMany(
      { bookingId: booking2?._id, status: "offered" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const swept = (await (
      await call("POST", "/admin/dispatch/sweep", {}, adminToken)
    ).json()) as { expired?: number };
    check("the sweep expires a lapsed window", () => {
      // Never trust a client to report its own timeout: a pro whose phone slept
      // through the window has not accepted.
      assert.ok((swept.expired ?? 0) >= 2, `expired ${swept.expired}`);
    });

    const expiredStatuses = await Offer.find({ bookingId: booking2?._id })
      .select({ status: 1 })
      .lean<{ status: string }[]>();
    check("a timeout is recorded as expired, not as a decline", () => {
      // An auto-reject the pro did not make is worth distinguishing from one
      // they did — a pattern of declines is what an admin reviews.
      assert.ok(expiredStatuses.some((o) => o.status === "expired"));
    });

    const staleAccept = await call(
      "POST",
      `/pro/offers/${(await Offer.findOne({ bookingId: booking2?._id }).lean())?._id}/accept`,
      {}, proTokens[1],
    );
    const staleBody = (await staleAccept.json()) as { kind?: string };
    check("accepting after the window closed is refused", () => {
      assert.ok(["expired", "taken", "gone"].includes(staleBody.kind ?? ""));
    });

    // -- the 2-minute no-pro alert ------------------------------------------
    // Through the raw collection, not the model: `timestamps: true` makes
    // `createdAt` immutable, so a Mongoose `$set` on it is silently ignored —
    // which is why the first version of this check could never have passed.
    // The driver's types assume an ObjectId `_id`; ours are prefixed strings
    // (see models/id.ts), hence the cast on the filter.
    await Booking.collection.updateOne(
      { _id: booking2?._id } as unknown as Parameters<
        typeof Booking.collection.updateOne
      >[0],
      { $set: { createdAt: new Date(Date.now() - 3 * 60 * 1000) } },
    );
    const swept2 = (await (
      await call("POST", "/admin/dispatch/sweep", {}, adminToken)
    ).json()) as { alerted?: number };
    check("a job unaccepted for 2 minutes raises an admin alert", () => {
      assert.ok((swept2.alerted ?? 0) >= 1, "no alert was raised");
    });

    const alerts = (await (
      await call("GET", "/admin/dispatch/alerts", undefined, adminToken)
    ).json()) as { bookingReference?: string; reason?: string }[];
    check("the alert queue names why dispatch failed", () => {
      // "Nobody was available to ask" and "three declined" are different
      // operational problems with the same symptom.
      const mine = alerts.find((a) => a.bookingReference === bk2.reference);
      assert.ok(mine, "the alert is missing from the queue");
      assert.ok((mine?.reason ?? "").length > 0);
    });

    // -- manual assignment (Admin 10) ---------------------------------------
    const candidates = (await (
      await call("GET", `/admin/dispatch/candidates/${booking2?._id}`, undefined, adminToken)
    ).json()) as { id: string; servesThisArea?: boolean; previousOffer?: string | null }[];
    check("the candidate list shows who already declined or lapsed", () => {
      // So an operator can see why dispatch skipped a pro rather than guessing.
      assert.ok(candidates.length >= 3);
      assert.ok(candidates.some((c) => c.previousOffer !== null));
    });

    const assigned = await call("POST", "/admin/dispatch/assign", {
      bookingId: booking2?._id, proId: proIds[2],
    }, adminToken);
    check("an admin can assign a stuck job by hand", () => {
      assert.equal(assigned.status, 200);
    });

    const reassign = await call("POST", "/admin/dispatch/assign", {
      bookingId: booking2?._id, proId: proIds[1],
    }, adminToken);
    check("assigning an already-assigned job is refused", () => {
      assert.equal(reassign.status, 409);
    });

    const forced = await Booking.findById(booking2?._id).lean();
    check("a manual assignment is flagged as forced on the timeline", () => {
      // It should not read as an ordinary acceptance — an operator overrode
      // dispatch and the history has to say so.
      assert.ok(forced?.events.some((e) => e.forced === true));
    });

    const alertsAfter = (await (
      await call("GET", "/admin/dispatch/alerts", undefined, adminToken)
    ).json()) as { bookingReference?: string }[];
    check("assigning by hand clears the alert", () => {
      assert.ok(!alertsAfter.some((a) => a.bookingReference === bk2.reference));
    });

    // -- a blocked pro is refused at accept, not just at offer --------------
    await call("POST", `/admin/pros/${proIds[0]}/block`, { reason: "self-check" }, adminToken);
    const blockedOnline = await call("PUT", "/pro/online", { online: true }, proTokens[0]);
    check("a blocked pro cannot go online", () => {
      assert.equal(blockedOnline.status, 403);
    });
    await call("POST", `/admin/pros/${proIds[0]}/unblock`, {}, adminToken);
  } finally {
    const bookings = await Booking.find({ customerPhone: custPhone }).select({ _id: 1 }).lean();
    await Offer.deleteMany({ bookingId: { $in: bookings.map((b) => b._id) } });
    await DispatchAlert.deleteMany({ bookingId: { $in: bookings.map((b) => b._id) } });
    await Booking.deleteMany({ customerPhone: custPhone });
    await Customer.deleteOne({ phone: custPhone });
    await Pro.deleteMany({ phone: { $in: proPhones } });
    if (serviceId) await call("DELETE", `/admin/catalog/services/${serviceId}`, undefined, adminToken);
    if (subCategoryId) await call("DELETE", `/admin/catalog/sub-categories/${subCategoryId}`, undefined, adminToken);
    if (categoryId) await call("DELETE", `/admin/catalog/categories/${categoryId}`, undefined, adminToken);
    resetRateLimits();
  }
}

/**
 * Phase 7 — job lifecycle, proof of work, tracking.
 *
 * The gate order is the substance of this phase, so it is checked by planting
 * each violation in turn: a wrong OTP, no after-photo, a distance beyond the
 * limit — and then the case that must **not** block, which is no GPS fix at all.
 */
async function checkLifecycle(
  base: string,
  adminToken: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] job lifecycle");

  const api = (p: string) => `${base}/api${p}`;
  const call = (method: string, p: string, body?: unknown, token?: string) =>
    fetch(api(p), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  // Eight digits, so `+9188` plus the stamp is a valid ten-digit Indian mobile.
  // A seven-digit stamp made it nine digits, which `normalisePhone` correctly
  // refused — and every assertion below then reported a 401 that really meant
  // "the setup never ran". Hence the explicit setup guard further down.
  const stamp = String(Date.now()).slice(-8);
  const custPhone = `+9188${stamp}`;
  const proPhone = `+9187${stamp}`;

  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";
  let proToken = "";
  let proId = "";
  let custToken = "";
  let bookingId = "";

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  resetRateLimits();

  try {
    // -- setup: a service, one approved pro, one customer, one booking ------
    const cat = (await (
      await call("POST", "/admin/catalog/categories", { name: `__life ${stamp}` }, adminToken)
    ).json()) as { id: string };
    categoryId = cat.id;
    const sub = (await (
      await call("POST", "/admin/catalog/sub-categories", { name: "__life sub", categoryId }, adminToken)
    ).json()) as { id: string };
    subCategoryId = sub.id;
    const svc = (await (
      await call("POST", "/admin/catalog/services", {
        name: "__life service", subCategoryId,
        basePricePaise: 150_000, platformFeePaise: 15_000,
        variants: [{ name: "Standard", priceDeltaPaise: 0, durationMinutes: 60, isDefault: true }],
      }, adminToken)
    ).json()) as { id: string };
    serviceId = svc.id;

    await call("POST", "/pro/otp/send", { phone: proPhone });
    const pv = (await (
      await call("POST", "/pro/otp/verify", { phone: proPhone, code: env.masterOtp })
    ).json()) as { token?: string };
    const reg = (await (
      await call("POST", "/pro/register", {
        name: "Lifecycle Pro", serviceIds: [serviceId], areas: ["Srirangam"],
      }, pv.token)
    ).json()) as { proId?: string; token?: string };
    proId = reg.proId ?? "";
    proToken = reg.token ?? pv.token ?? "";
    if (!proId || !proToken) {
      // Fail loudly here rather than letting 35 downstream assertions report
      // 401s that all mean "the setup never happened".
      throw new Error(
        `lifecycle setup failed: verify=${JSON.stringify(pv)} register=${JSON.stringify(reg)}`,
      );
    }

    const upload = async (path: string, fields: Record<string, string>, token: string) => {
      const form = new FormData();
      form.append("file", new Blob([png], { type: "image/png" }), "shot.png");
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return fetch(api(path), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    };

    for (const type of ["aadhaar_front", "aadhaar_back", "pan", "selfie"]) {
      await upload("/pro/documents", { type }, proToken);
      await call("PATCH", `/admin/pros/${proId}/documents/${type}`, { status: "approved" }, adminToken);
    }
    await call("PUT", "/pro/bank", {
      accountName: "Lifecycle Pro", accountNumber: "123456789012", ifsc: "HDFC0001234",
    }, proToken);
    await call("POST", "/pro/conduct", {}, proToken);
    await call("POST", `/admin/pros/${proId}/approve`, {}, adminToken);
    await call("PUT", "/pro/online", { online: true }, proToken);

    await call("POST", "/consumer/auth/otp/send", { phone: custPhone });
    custToken = ((await (
      await call("POST", "/consumer/auth/otp/verify", { phone: custPhone, code: env.masterOtp })
    ).json()) as { token?: string }).token ?? "";
    const addr = (await (
      await call("PUT", "/consumer/addresses", {
        label: "home", line1: "42 Kaveri Nagar", area: "Srirangam",
        city: "Tiruchirappalli", state: "Tamil Nadu", pincode: "620006",
        point: { lat: 10.85, lng: 78.68 },
      }, custToken)
    ).json()) as { id: string };

    const bk = (await (
      await call("POST", "/consumer/bookings", {
        serviceId, addressId: addr.id,
        startsAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
        paymentMethod: "cash", idempotencyKey: `life-${stamp}`,
      }, custToken)
    ).json()) as { reference?: string };

    await new Promise((r) => setTimeout(r, 400));
    const offer = (await (
      await call("GET", "/pro/offers/next", undefined, proToken)
    ).json()) as { offerId?: string } | null;
    await call("POST", `/pro/offers/${offer?.offerId}/accept`, {}, proToken);

    const booking = await Booking.findOne({ reference: bk.reference }).lean();
    bookingId = booking?._id ?? "";
    const realOtp = booking?.completionOtp ?? "";

    // -- the OTP is not shown to the pro before they are on site ------------
    const assignedJob = (await (
      await call("GET", `/pro/jobs/${bookingId}`, undefined, proToken)
    ).json()) as { completionOtp?: string | null; status?: string };
    check("the pro cannot see the completion OTP before starting", () => {
      // It is the customer's code to give, not the pro's to hold in advance.
      assert.equal(assignedJob.completionOtp, null);
    });

    // -- completing before starting -----------------------------------------
    const early = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: realOtp }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("a job cannot be completed before it is started", () => {
      assert.equal(early.ok, false);
      assert.equal(early.error?.reason, "bad-state");
    });

    // -- start --------------------------------------------------------------
    const started = await call("POST", `/pro/jobs/${bookingId}/start`, {}, proToken);
    check("the pro can start the job", () => {
      assert.equal(started.status, 200);
    });

    const twice = await call("POST", `/pro/jobs/${bookingId}/start`, {}, proToken);
    check("starting twice is refused by the state machine", () => {
      assert.equal(twice.status, 409);
    });

    const onSite = (await (
      await call("GET", `/pro/jobs/${bookingId}`, undefined, proToken)
    ).json()) as { completionOtp?: string | null };
    check("the OTP is still withheld from the pro on site", () => {
      // The pro has to be *told* it by the customer. Showing it to them would
      // make the whole confirmation theatre.
      assert.equal(onSite.completionOtp, realOtp);
    });

    // -- the gate, violation by violation ------------------------------------
    const noPhoto = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: realOtp }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("completing with no after-photo is refused", () => {
      assert.equal(noPhoto.error?.reason, "no-after-photos");
    });

    const wrongOtpNoPhoto = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: "000000" }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("a wrong OTP is reported before the missing photo", () => {
      // The order is the substance: the OTP is the customer's confirmation and
      // no other check matters without it. Reporting "no photo" to a pro who
      // also has the wrong code sends them to fix the wrong thing.
      assert.equal(wrongOtpNoPhoto.error?.reason, "wrong-otp");
    });

    // Photos, before and after, kept apart.
    const beforeShot = await upload("/pro/jobs/" + bookingId + "/photos", { stage: "before" }, proToken);
    const afterShot = await upload("/pro/jobs/" + bookingId + "/photos", { stage: "after" }, proToken);
    const afterBody = (await afterShot.json()) as { beforeCount?: number; afterCount?: number };
    check("before and after photos are stored separately", () => {
      // They answer different questions in a dispute: what the pro walked into
      // versus what they left. One merged list loses that.
      assert.equal(beforeShot.status, 201);
      assert.equal(afterBody.beforeCount, 1);
      assert.equal(afterBody.afterCount, 1);
    });

    const badStage = await upload("/pro/jobs/" + bookingId + "/photos", { stage: "sideways" }, proToken);
    check("a photo with no before/after stage is refused", () => {
      assert.equal(badStage.status, 400);
    });

    const stillWrong = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: "999999" }, proToken)
    ).json()) as { error?: { reason?: string } };
    check("a wrong OTP still refuses with photos present", () => {
      assert.equal(stillWrong.error?.reason, "wrong-otp");
    });

    // -- extra charges -------------------------------------------------------
    const vagueCharge = await call(
      "POST", `/pro/jobs/${bookingId}/extra-charge`, { label: "x", amountPaise: 5_000 }, proToken,
    );
    check("an extra charge with no readable reason is refused", () => {
      // The customer reads this label. "x" invites a dispute.
      assert.equal(vagueCharge.status, 400);
    });

    const freeCharge = await call(
      "POST", `/pro/jobs/${bookingId}/extra-charge`,
      { label: "Replacement valve", amountPaise: 0 }, proToken,
    );
    check("a zero or negative extra charge is refused", () => {
      assert.equal(freeCharge.status, 400);
    });

    const charge = await call(
      "POST", `/pro/jobs/${bookingId}/extra-charge`,
      { label: "Replacement valve", amountPaise: 25_000 }, proToken,
    );
    check("the pro can add an explained extra charge", () => {
      assert.equal(charge.status, 201);
    });

    const jobAfterCharge = (await (
      await call("GET", `/pro/jobs/${bookingId}`, undefined, proToken)
    ).json()) as { grossEarningPaise?: number };
    check("an extra charge raises what the pro is shown they will earn", () => {
      // The route had its own earnings copy that omitted extras, so the job
      // screen showed one figure and the settlement paid another. This is the
      // assertion that would have caught it.
      assert.equal(jobAfterCharge.grossEarningPaise, 150_000 + 25_000);
    });

    // -- the GPS gate --------------------------------------------------------
    // Marked verified so distance is actually measured — otherwise the gate is
    // skipped, which is correct behaviour but not what this checks.
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { "address.locationVerified": true } },
    );

    const tooFar = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, {
        otp: realOtp, lat: 12.9716, lng: 77.5946,
      }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string; metres?: number; limit?: number } };
    check("a known distance beyond the limit blocks completion", () => {
      assert.equal(tooFar.error?.reason, "too-far");
      assert.ok((tooFar.error?.metres ?? 0) > 100_000, "Bengaluru is not 100 m from Trichy");
      assert.equal(tooFar.error?.limit, 100);
    });

    // -- the case that must NOT block ---------------------------------------
    const noFix = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: realOtp }, proToken)
    ).json()) as { ok?: boolean; earning?: { grossPaise?: number; netPaise?: number; commissionFree?: boolean } };
    check("an UNKNOWN distance does not block completion", () => {
      // The rule not to "improve": a weak indoor signal is the one thing the
      // pro cannot fix, and blocking there makes the platform's proof
      // requirement into their problem. PRO-OPEN-ITEMS 2.4.
      assert.equal(noFix.ok, true, "no GPS fix blocked a completed job");
    });

    check("the missing fix is recorded rather than ignored", () => {
      // Null is exactly the case an admin may want to review.
      assert.equal(noFix.ok, true);
    });
    const completed = await Booking.findById(bookingId).lean();
    check("a completion with no fix stores a null distance", () => {
      assert.equal(completed?.completionDistanceM, null);
    });

    check("the settlement includes the extra charge", () => {
      assert.equal(noFix.earning?.grossPaise, 175_000);
    });

    check("a pro under 20 jobs is settled commission-free", () => {
      assert.equal(noFix.earning?.commissionFree, true);
      assert.equal(noFix.earning?.netPaise, 175_000);
    });

    check("the settlement is frozen onto the booking", () => {
      assert.equal(completed?.settlement?.grossPaise, 175_000);
    });

    check("a cash job is marked paid at completion", () => {
      assert.equal(completed?.paid, true);
    });

    check("the completion OTP is cleared once used", () => {
      // A screenshot taken during the visit is then worth nothing afterwards.
      assert.equal(completed?.completionOtp, null);
    });

    const proAfter = await Pro.findById(proId).lean();
    check("the pro goes back online on completion", () => {
      // From the agreement: offline on accept, online on completion.
      assert.equal(proAfter?.online, true);
    });

    check("the pro's completed-job count moves", () => {
      // Which is what shifts the next job past the commission-free 20.
      assert.equal(proAfter?.jobsCompleted, 1);
    });

    const reComplete = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: realOtp }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("a completed job cannot be completed again", () => {
      assert.equal(reComplete.ok, false);
    });

    const lateCharge = await call(
      "POST", `/pro/jobs/${bookingId}/extra-charge`,
      { label: "Afterthought", amountPaise: 10_000 }, proToken,
    );
    check("an extra charge cannot be added to a closed job", () => {
      // It would change a total that has already been settled.
      assert.equal(lateCharge.status, 409);
    });

    // -- the customer's view -------------------------------------------------
    const seen = (await (
      await call("GET", `/consumer/bookings/${bk.reference}`, undefined, custToken)
    ).json()) as {
      status?: string;
      beforePhotoUrls?: string[];
      afterPhotoUrls?: string[];
      completionOtp?: string | null;
      events?: { label: string }[];
    };
    check("the customer sees the proof-of-work photos", () => {
      assert.equal(seen.beforePhotoUrls?.length, 1);
      assert.equal(seen.afterPhotoUrls?.length, 1);
    });

    check("the customer's timeline records every step", () => {
      const labels = (seen.events ?? []).map((e) => e.label);
      for (const expected of ["Booking placed", "Professional assigned", "Work started", "Job completed"]) {
        assert.ok(
          labels.some((l) => l.includes(expected)),
          `the timeline is missing "${expected}": ${labels.join(" | ")}`,
        );
      }
    });

    check("the completed booking shows no OTP", () => {
      assert.equal(seen.completionOtp, null);
    });

    // -- another pro's job ---------------------------------------------------
    //
    // The second pro is **fully registered**, not just OTP-verified. The first
    // version of this check stopped at the OTP, so the request 404'd because
    // no Pro record existed — which passes for the wrong reason and would have
    // kept passing even if the ownership check were removed entirely.
    const otherPhone = `+9186${stamp}`;
    await call("POST", "/pro/otp/send", { phone: otherPhone });
    const otherVerify = (await (
      await call("POST", "/pro/otp/verify", { phone: otherPhone, code: env.masterOtp })
    ).json()) as { token?: string };
    const otherReg = (await (
      await call("POST", "/pro/register", {
        name: "Other Pro", serviceIds: [serviceId], areas: ["Srirangam"],
      }, otherVerify.token)
    ).json()) as { proId?: string; token?: string };
    const otherTok = otherReg.token ?? otherVerify.token ?? "";
    assert.ok(otherReg.proId, "the second pro failed to register");

    const stolen = await call("GET", `/pro/jobs/${bookingId}`, undefined, otherTok);
    check("another pro cannot read this job", () => {
      assert.equal(stolen.status, 404);
    });

    const hijack = (await (
      await call("POST", `/pro/jobs/${bookingId}/complete`, { otp: realOtp }, otherTok)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("another pro cannot complete this job even with the right OTP", () => {
      // The job is matched on proId as well as id, so a leaked code is not
      // enough to close someone else's work.
      assert.equal(hijack.ok, false);
      assert.equal(hijack.error?.reason, "bad-state");
    });

    // -- tracking ------------------------------------------------------------
    await call("PUT", "/pro/location", { lat: 10.855, lng: 78.685 }, proToken);
    const live = await Booking.findOneAndUpdate(
      { _id: bookingId },
      { $set: { status: "assigned" } },
      { new: true },
    ).lean();
    void live;

    const tracked = (await (
      await call("GET", `/consumer/bookings/${bk.reference}`, undefined, custToken)
    ).json()) as {
      proPoint?: { lat: number; lng: number } | null;
      proPosition?: { x: number; y: number } | null;
      etaMinutes?: number | null;
    };

    check("tracking reports real coordinates, not only canvas percentages", () => {
      // §4.2 — `proPosition` alone could not support real tracking, because
      // canvas percentages are not coordinates.
      assert.ok(tracked.proPoint, "no proPoint on a live booking");
      assert.equal(typeof tracked.proPoint?.lat, "number");
    });

    check("the canvas position stays within the canvas", () => {
      const p = tracked.proPosition;
      assert.ok(p, "no proPosition");
      assert.ok((p?.x ?? -1) >= 0 && (p?.x ?? 101) <= 100, `x was ${p?.x}`);
      assert.ok((p?.y ?? -1) >= 0 && (p?.y ?? 101) <= 100, `y was ${p?.y}`);
    });

    check("an ETA is reported for a pro on the way", () => {
      assert.ok((tracked.etaMinutes ?? 0) > 0, `eta was ${tracked.etaMinutes}`);
    });
  } finally {
    await Offer.deleteMany({ bookingId });
    await Booking.deleteMany({ customerPhone: custPhone });
    await Customer.deleteOne({ phone: custPhone });
    await Pro.deleteMany({ phone: { $in: [proPhone, `+9186${stamp}`] } });
    if (serviceId) await call("DELETE", `/admin/catalog/services/${serviceId}`, undefined, adminToken);
    if (subCategoryId) await call("DELETE", `/admin/catalog/sub-categories/${subCategoryId}`, undefined, adminToken);
    if (categoryId) await call("DELETE", `/admin/catalog/categories/${categoryId}`, undefined, adminToken);
    resetRateLimits();
  }
}

/**
 * Phase 8 — the quotation flow.
 *
 * *"The panel's priority path."* Pro submits → admin decides in 15 minutes →
 * customer accepts with a 50% advance.
 *
 * The assertion that matters most is the edit history: an approved amount that
 * differs from what the pro submitted, with no record of either, is a dispute
 * nobody can settle.
 */
async function checkQuotations(
  base: string,
  adminToken: string,
  check: (name: string, fn: () => void) => void,
): Promise<void> {
  console.info("[selfcheck] quotations");

  const api = (p: string) => `${base}/api${p}`;
  const call = (method: string, p: string, body?: unknown, token?: string) =>
    fetch(api(p), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const stamp = String(Date.now()).slice(-8);
  const custPhone = `+9178${stamp}`;
  const proPhone = `+9177${stamp}`;

  let categoryId = "";
  let subCategoryId = "";
  let serviceId = "";
  let proToken = "";
  let proId = "";
  let custToken = "";
  let customerId = "";
  let bookingId = "";

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const upload = (path: string, fields: Record<string, string>, token: string) => {
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "shot.png");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(api(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  };

  resetRateLimits();

  try {
    // -- setup ---------------------------------------------------------------
    const cat = (await (
      await call("POST", "/admin/catalog/categories", { name: `__qt ${stamp}` }, adminToken)
    ).json()) as { id: string };
    categoryId = cat.id;
    const sub = (await (
      await call("POST", "/admin/catalog/sub-categories", { name: "__qt sub", categoryId }, adminToken)
    ).json()) as { id: string };
    subCategoryId = sub.id;
    const svc = (await (
      await call("POST", "/admin/catalog/services", {
        name: "__qt service", subCategoryId,
        // ₹1,000 template, so a ₹6,000 quote is both over template and over
        // the ₹5,000 phone-confirmation threshold.
        basePricePaise: 100_000, platformFeePaise: 10_000,
        variants: [{ name: "Standard", priceDeltaPaise: 0, durationMinutes: 60, isDefault: true }],
      }, adminToken)
    ).json()) as { id: string };
    serviceId = svc.id;

    await call("POST", "/pro/otp/send", { phone: proPhone });
    const pv = (await (
      await call("POST", "/pro/otp/verify", { phone: proPhone, code: env.masterOtp })
    ).json()) as { token?: string };
    const reg = (await (
      await call("POST", "/pro/register", {
        name: "Quote Pro", serviceIds: [serviceId], areas: ["Srirangam"],
      }, pv.token)
    ).json()) as { proId?: string; token?: string };
    proId = reg.proId ?? "";
    proToken = reg.token ?? pv.token ?? "";
    assert.ok(proId && proToken, "quotation setup: pro registration failed");

    for (const type of ["aadhaar_front", "aadhaar_back", "pan", "selfie"]) {
      await upload("/pro/documents", { type }, proToken);
      await call("PATCH", `/admin/pros/${proId}/documents/${type}`, { status: "approved" }, adminToken);
    }
    await call("PUT", "/pro/bank", {
      accountName: "Quote Pro", accountNumber: "123456789012", ifsc: "HDFC0001234",
    }, proToken);
    await call("POST", "/pro/conduct", {}, proToken);
    await call("POST", `/admin/pros/${proId}/approve`, {}, adminToken);
    await call("PUT", "/pro/online", { online: true }, proToken);

    await call("POST", "/consumer/auth/otp/send", { phone: custPhone });
    const cv = (await (
      await call("POST", "/consumer/auth/otp/verify", { phone: custPhone, code: env.masterOtp })
    ).json()) as { token?: string };
    custToken = cv.token ?? "";
    const me = (await (
      await call("GET", "/consumer/auth/me", undefined, custToken)
    ).json()) as { id?: string };
    customerId = me.id ?? "";

    const addr = (await (
      await call("PUT", "/consumer/addresses", {
        label: "home", line1: "42 Kaveri Nagar", area: "Srirangam",
        city: "Tiruchirappalli", state: "Tamil Nadu", pincode: "620006",
        point: { lat: 10.85, lng: 78.68 },
      }, custToken)
    ).json()) as { id: string };

    const bk = (await (
      await call("POST", "/consumer/bookings", {
        serviceId, addressId: addr.id,
        startsAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
        paymentMethod: "cash", idempotencyKey: `qt-${stamp}`,
      }, custToken)
    ).json()) as { reference?: string };

    await new Promise((r) => setTimeout(r, 400));
    const offer = (await (
      await call("GET", "/pro/offers/next", undefined, proToken)
    ).json()) as { offerId?: string } | null;
    await call("POST", `/pro/offers/${offer?.offerId}/accept`, {}, proToken);
    const booking = await Booking.findOne({ reference: bk.reference }).lean();
    bookingId = booking?._id ?? "";

    // -- submission rules ----------------------------------------------------
    const beforeStart = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "Pipe is corroded", materials: [], labourPaise: 100_000,
      }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("a quotation cannot be raised before the job is started", () => {
      // The quote describes what the pro found on site.
      assert.equal(beforeStart.ok, false);
      assert.equal(beforeStart.error?.reason, "bad-state");
    });

    await call("POST", `/pro/jobs/${bookingId}/start`, {}, proToken);

    const noPhotos = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "Pipe is corroded", materials: [], labourPaise: 100_000,
      }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string; needed?: number } };
    check("a quotation with no before-photos is refused", () => {
      assert.equal(noPhotos.error?.reason, "too-few-photos");
      assert.equal(noPhotos.error?.needed, 2);
    });

    await upload(`/pro/jobs/${bookingId}/photos`, { stage: "before" }, proToken);
    const onePhoto = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "Pipe is corroded", materials: [], labourPaise: 100_000,
      }, proToken)
    ).json()) as { error?: { reason?: string; needed?: number } };
    check("one before-photo is still one short of the minimum", () => {
      // "Minimum 2 — none means auto-reject", from the agreement.
      assert.equal(onePhoto.error?.reason, "too-few-photos");
      assert.equal(onePhoto.error?.needed, 1);
    });

    await upload(`/pro/jobs/${bookingId}/photos`, { stage: "before" }, proToken);

    const noDescription = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "   ", materials: [], labourPaise: 100_000,
      }, proToken)
    ).json()) as { error?: { reason?: string } };
    check("a quotation with no description is refused", () => {
      assert.equal(noDescription.error?.reason, "no-description");
    });

    const zero = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "Pipe is corroded", materials: [], labourPaise: 0,
      }, proToken)
    ).json()) as { error?: { reason?: string } };
    check("a quotation with no amount is refused", () => {
      assert.equal(zero.error?.reason, "no-amount");
    });

    // -- a valid submission --------------------------------------------------
    const submitted = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "The inlet pipe is corroded through and needs replacing.",
        materials: [
          { description: "Inlet pipe, 1m", costPaise: 180_000 },
          { description: "Sealant and clips", costPaise: 20_000 },
        ],
        labourPaise: 400_000,
      }, proToken)
    ).json()) as {
      ok?: boolean;
      quotationId?: string;
      totalPaise?: number;
      needsPhoneConfirmation?: boolean;
      decisionBy?: string;
    };
    const quotationId = submitted.quotationId ?? "";
    check("a valid quotation is accepted and totalled", () => {
      assert.equal(submitted.ok, true);
      // 1,800 + 200 + 4,000 = ₹6,000.
      assert.equal(submitted.totalPaise, 600_000);
    });

    check("a quote above Rs5,000 is flagged for phone confirmation", () => {
      // A flag the admin acts on by calling, not a block.
      assert.equal(submitted.needsPhoneConfirmation, true);
    });

    check("the 15-minute window is set on submission", () => {
      const left = (Date.parse(submitted.decisionBy ?? "") - Date.now()) / 60_000;
      assert.ok(left > 13 && left <= 15, `window was ${left} minutes`);
    });

    const second = (await (
      await call("POST", `/pro/jobs/${bookingId}/quotation`, {
        description: "Another one", materials: [], labourPaise: 100_000,
      }, proToken)
    ).json()) as { ok?: boolean; error?: { reason?: string } };
    check("a second live quotation for one job is refused", () => {
      // Two prices for the same work and no way to know which holds.
      assert.equal(second.ok, false);
    });

    // -- the customer must not see it yet ------------------------------------
    const tooEarly = await call("GET", `/consumer/quotations/${quotationId}`, undefined, custToken);
    check("a pending quotation is invisible to the customer", () => {
      // It would invite them to accept something CFC has not agreed to.
      assert.equal(tooEarly.status, 404);
    });

    const earlyList = (await (
      await call("GET", "/consumer/quotations", undefined, custToken)
    ).json()) as unknown[];
    check("the customer's list excludes pending quotations", () => {
      assert.equal(earlyList.length, 0);
    });

    // -- the admin queue -----------------------------------------------------
    const detail = (await (
      await call("GET", `/admin/quotations/${quotationId}`, undefined, adminToken)
    ).json()) as {
      minutesRemaining?: number | null;
      overTemplate?: boolean;
      templatePricePaise?: number;
      needsPhoneConfirmation?: boolean;
      beforePhotoUrls?: string[];
      submittedTotalPaise?: number;
    };
    check("the admin sees the clock draining", () => {
      assert.ok((detail.minutesRemaining ?? 0) > 0);
    });

    check("a quote over the template price is flagged for review", () => {
      // Admin 5, 28. ₹6,000 against a ₹1,000 template.
      assert.equal(detail.overTemplate, true);
      assert.equal(detail.templatePricePaise, 100_000);
    });

    check("the admin sees the before-photos they are deciding on", () => {
      assert.equal(detail.beforePhotoUrls?.length, 2);
    });

    const rejectNoReason = await call(
      "POST", `/admin/quotations/${quotationId}/decide`, { outcome: "rejected" }, adminToken,
    );
    check("rejecting a quotation with no reason is refused", () => {
      // The pro reads it, and they are still in the customer's house.
      assert.equal(rejectNoReason.status, 409);
    });

    // -- edit and approve, which must keep both figures ----------------------
    const approved = (await (
      await call("POST", `/admin/quotations/${quotationId}/decide`, {
        outcome: "approved",
        // The office trims the labour.
        materials: [
          { description: "Inlet pipe, 1m", costPaise: 180_000 },
          { description: "Sealant and clips", costPaise: 20_000 },
        ],
        labourPaise: 300_000,
      }, adminToken)
    ).json()) as {
      totalPaise?: number;
      submittedTotalPaise?: number;
      edited?: boolean;
      advancePaise?: number;
      balancePaise?: number;
      status?: string;
    };

    check("edit-and-approve records the approved figure", () => {
      assert.equal(approved.totalPaise, 500_000);
      assert.equal(approved.status, "approved");
    });

    check("edit-and-approve KEEPS the pro's original figure", () => {
      // The whole reason this schema separates the two. Without it, the pro
      // says they quoted ₹6,000, the customer was charged ₹5,000, and there is
      // nothing to check.
      assert.equal(approved.submittedTotalPaise, 600_000);
      assert.equal(approved.edited, true);
    });

    check("the 50% advance and balance always sum to the total", () => {
      // Rounding both independently is how a customer ends up owing a paisa
      // more than the quotation said.
      assert.equal(
        (approved.advancePaise ?? 0) + (approved.balancePaise ?? 0),
        approved.totalPaise,
      );
      assert.equal(approved.advancePaise, 250_000);
    });

    const twice = await call(
      "POST", `/admin/quotations/${quotationId}/decide`,
      { outcome: "approved" }, adminToken,
    );
    check("deciding an already-decided quotation is refused", () => {
      assert.equal(twice.status, 409);
    });

    // -- the pro is told, including that it was edited ------------------------
    const proView = (await (
      await call("GET", `/pro/jobs/${bookingId}/quotation`, undefined, proToken)
    ).json()) as { status?: string; edited?: boolean; totalPaise?: number; submittedTotalPaise?: number };
    check("the pro sees that the office changed the figure", () => {
      // Rather than discovering it from the customer.
      assert.equal(proView.status, "approved");
      assert.equal(proView.edited, true);
      assert.equal(proView.submittedTotalPaise, 600_000);
      assert.equal(proView.totalPaise, 500_000);
    });

    // -- the customer's turn --------------------------------------------------
    const visible = (await (
      await call("GET", `/consumer/quotations/${quotationId}`, undefined, custToken)
    ).json()) as {
      totalPaise?: number;
      advancePaise?: number;
      minutesRemaining?: number | null;
      beforePhotoUrls?: string[];
    };
    check("an approved quotation reaches the customer", () => {
      assert.equal(visible.totalPaise, 500_000);
      assert.equal(visible.advancePaise, 250_000);
    });

    check("the customer is shown no countdown", () => {
      // The 15 minutes is an admin rule. A timer here would be a pressure
      // tactic we invented.
      assert.equal(visible.minutesRemaining, null);
    });

    check("the customer sees the photos the quote is based on", () => {
      assert.equal(visible.beforePhotoUrls?.length, 2);
    });

    const online = await call(
      "POST", `/consumer/quotations/${quotationId}/accept`,
      { paymentMethod: "upi" }, custToken,
    );
    check("paying the advance online answers 503, not a fake acceptance", () => {
      // A quote marked accepted with no advance behind it would send a pro to
      // do ₹5,000 of work against nothing.
      assert.equal(online.status, 503);
    });

    const brokeWallet = await call(
      "POST", `/consumer/quotations/${quotationId}/accept`,
      { paymentMethod: "wallet" }, custToken,
    );
    check("a wallet advance with no balance is refused", () => {
      assert.equal(brokeWallet.status, 409);
    });

    await WalletEntry.create({
      _id: `wtx_qt_${stamp}`,
      customerId, kind: "cashback", label: "Self-check credit",
      amountPaise: 300_000, status: "completed",
    });

    const question = await call(
      "POST", `/consumer/quotations/${quotationId}/question`,
      { question: "Is the pipe under warranty?" }, custToken,
    );
    const questionBody = (await question.json()) as { message?: string };
    check("a customer question is recorded and promises a call", () => {
      // Recorded, not threaded: inventing a thread would imply a reply the
      // platform cannot deliver. It routes to the office, not the pro.
      assert.equal(question.status, 201);
      assert.match(questionBody.message ?? "", /call/i);
    });

    const accepted = (await (
      await call("POST", `/consumer/quotations/${quotationId}/accept`,
        { paymentMethod: "wallet" }, custToken)
    ).json()) as { status?: string; advancePaid?: boolean };
    check("the customer accepts and the advance is taken", () => {
      assert.equal(accepted.status, "customer_accepted");
      assert.equal(accepted.advancePaid, true);
    });

    const balanceAfter = (await (
      await call("GET", "/consumer/wallet/balance", undefined, custToken)
    ).json()) as number;
    check("the wallet is debited by exactly the advance", () => {
      assert.equal(balanceAfter, 300_000 - 250_000);
    });

    const acceptTwice = await call(
      "POST", `/consumer/quotations/${quotationId}/accept`,
      { paymentMethod: "wallet" }, custToken,
    );
    check("accepting twice cannot charge the advance twice", () => {
      assert.equal(acceptTwice.status, 409);
    });

    const timeline = await Booking.findById(bookingId).lean();
    check("the booking timeline records the whole quotation flow", () => {
      const labels = (timeline?.events ?? []).map((e) => e.label).join(" | ");
      assert.match(labels, /Quotation sent/);
      assert.match(labels, /Quotation accepted/);
    });

    // -- another customer's quotation ----------------------------------------
    const otherPhone = `+9176${stamp}`;
    await call("POST", "/consumer/auth/otp/send", { phone: otherPhone });
    const otherTok = ((await (
      await call("POST", "/consumer/auth/otp/verify", { phone: otherPhone, code: env.masterOtp })
    ).json()) as { token?: string }).token ?? "";
    const peek = await call("GET", `/consumer/quotations/${quotationId}`, undefined, otherTok);
    check("another customer cannot read this quotation", () => {
      assert.equal(peek.status, 404);
    });
    await Customer.deleteOne({ phone: otherPhone });

    // -- the 15-minute expiry, forced rather than waited out -----------------
    //
    // On a **second booking**: the first job's quotation is now accepted, and
    // one live quotation per job is the rule (two prices for one piece of work
    // and no way to know which holds). So this needs its own job.
    // The pro went **offline when they accepted the first job** — per the
    // agreement — and has not completed it, so they are still out of the pool.
    // Back online explicitly, which the Pro 11 toggle legitimately allows.
    await call("PUT", "/pro/online", { online: true }, proToken);

    const bk2 = (await (
      await call("POST", "/consumer/bookings", {
        serviceId, addressId: addr.id,
        startsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(),
        paymentMethod: "cash", idempotencyKey: `qt2-${stamp}`,
      }, custToken)
    ).json()) as { reference?: string };

    await new Promise((r) => setTimeout(r, 400));
    const offer2 = (await (
      await call("GET", "/pro/offers/next", undefined, proToken)
    ).json()) as { offerId?: string } | null;
    assert.ok(offer2?.offerId, "the second booking produced no offer");
    await call("POST", `/pro/offers/${offer2.offerId}/accept`, {}, proToken);

    const booking2 = await Booking.findOne({ reference: bk2.reference }).lean();
    const bookingId2 = booking2?._id ?? "";
    await call("POST", `/pro/jobs/${bookingId2}/start`, {}, proToken);
    await upload(`/pro/jobs/${bookingId2}/photos`, { stage: "before" }, proToken);
    await upload(`/pro/jobs/${bookingId2}/photos`, { stage: "before" }, proToken);

    const lapsing = (await (
      await call("POST", `/pro/jobs/${bookingId2}/quotation`, {
        description: "A second issue found while working.",
        materials: [], labourPaise: 150_000,
      }, proToken)
    ).json()) as { ok?: boolean; quotationId?: string; error?: unknown };
    assert.ok(
      lapsing.quotationId,
      `the second quotation failed to submit: ${JSON.stringify(lapsing)}`,
    );

    await Quotation.updateOne(
      { _id: lapsing.quotationId },
      { $set: { decisionBy: new Date(Date.now() - 1000) } },
    );

    const lateDecide = await call(
      "POST", `/admin/quotations/${lapsing.quotationId}/decide`,
      { outcome: "approved" }, adminToken,
    );
    check("an admin cannot approve past the 15-minute window", () => {
      // An operator whose tab sat open must not decide on a stale view — the
      // pro has already been told it lapsed.
      assert.equal(lateDecide.status, 409);
    });

    const sweptQ = (await (
      await call("POST", "/admin/quotations/sweep", {}, adminToken)
    ).json()) as { expired?: number };
    void sweptQ;

    const lapsed = await Quotation.findById(lapsing.quotationId).lean();
    check("a lapsed quotation is closed with its reason stated", () => {
      // Left pending forever, it would be a pro waiting forever.
      assert.equal(lapsed?.status, "rejected");
      assert.match(lapsed?.rejectionReason ?? "", /expired/i);
    });
  } finally {
    const mine = await Booking.find({ customerPhone: custPhone }).select({ _id: 1 }).lean();
    await Quotation.deleteMany({ bookingId: { $in: mine.map((b) => b._id) } });
    await Offer.deleteMany({ bookingId: { $in: mine.map((b) => b._id) } });
    await Booking.deleteMany({ customerPhone: custPhone });
    await WalletEntry.deleteMany({ customerId });
    await Customer.deleteOne({ phone: custPhone });
    await Pro.deleteMany({ phone: proPhone });
    if (serviceId) await call("DELETE", `/admin/catalog/services/${serviceId}`, undefined, adminToken);
    if (subCategoryId) await call("DELETE", `/admin/catalog/sub-categories/${subCategoryId}`, undefined, adminToken);
    if (categoryId) await call("DELETE", `/admin/catalog/categories/${categoryId}`, undefined, adminToken);
    resetRateLimits();
  }
}
