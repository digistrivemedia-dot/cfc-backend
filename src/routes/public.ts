import { Router } from "express";
import { getSettings } from "../models/settings";
import { badRequest, notFound } from "../error";
import { slotsFor } from "../services/slots";
import {
  findService,
  listCategories,
  listServices,
  listSubCategories,
} from "../services/catalog-read";

/**
 * Endpoints that need no token.
 *
 * Kept as its own group so "does this need auth?" is answered by which router a
 * route is mounted on, rather than by remembering to add a middleware. Anything
 * added here is public by construction — which is the point, and also the risk,
 * so the bar for adding is that an anonymous visitor is *meant* to read it.
 */
export const publicRouter = Router();

/**
 * `getServiceAreas` — the areas CFC operates in.
 *
 * Stage A's proof endpoint: it is the shortest possible path through every
 * piece of the new plumbing (live flag → `fetchJson` → CORS → Express → Mongo →
 * error envelope), so when it renders in the admin area filter, all of that is
 * verified at once rather than assumed.
 *
 * Public because the consumer app shows service areas to visitors who have not
 * signed in. Writing it is Admin 47, in Stage C.
 */
publicRouter.get("/service-areas", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings.serviceAreas);
});

/**
 * The catalogue, as a customer sees it.
 *
 * Every route here passes `activeOnly: true`. That single flag is the whole
 * difference between this and the admin's view of the same data, and it is the
 * reason the admin's switch means something: a category an operator switched
 * off disappears from the app while staying visible — and reversible — in the
 * panel.
 *
 * Public because the consumer app shows the catalogue to visitors who have not
 * signed in. Browsing does not require an account; booking does.
 */

publicRouter.get("/catalog/categories", async (_req, res) => {
  res.json(await listCategories({ activeOnly: true }));
});

publicRouter.get("/catalog/sub-categories", async (req, res) => {
  const categoryId =
    typeof req.query["categoryId"] === "string" ? req.query["categoryId"] : undefined;
  res.json(
    await listSubCategories({
      activeOnly: true,
      ...(categoryId ? { categoryId } : {}),
    }),
  );
});

publicRouter.get("/catalog/services", async (req, res) => {
  const q = req.query;
  res.json(
    await listServices({
      activeOnly: true,
      search: typeof q["search"] === "string" ? q["search"] : undefined,
      categoryId: typeof q["categoryId"] === "string" ? q["categoryId"] : undefined,
      subCategoryId:
        typeof q["subCategoryId"] === "string" ? q["subCategoryId"] : undefined,
    }),
  );
});

/**
 * One service.
 *
 * 404s for an inactive service as well as a missing one: to a customer
 * following an old link they are the same thing, and `getService` in the mock
 * layer already throws *"That service is not available."* for exactly this.
 */
/**
 * Arrival windows for a service on a day. Customer 15.
 *
 * Public: the slot grid is shown before a customer signs in, because being made
 * to sign in to find out whether anyone is free tomorrow is a step the 3-click
 * target cannot afford.
 */
publicRouter.get("/catalog/services/:id/slots", async (req, res) => {
  const date = req.query["date"];
  if (typeof date !== "string") {
    throw badRequest("Which date?", "MISSING_DATE");
  }
  const area = typeof req.query["area"] === "string" ? req.query["area"] : undefined;
  res.json(await slotsFor(req.params.id, date, area));
});

publicRouter.get("/catalog/services/:id", async (req, res) => {
  const service = await findService(req.params.id);
  if (!service || !service.active) {
    throw notFound("That service is not available.");
  }
  res.json(service);
});
