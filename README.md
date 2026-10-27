# CFC Backend

The API behind the three frontend apps in `../cfc-frontend`. Node + Express +
MongoDB Atlas.

The execution plan lives in `../cfc-frontend/BACKEND-PLAN.md` — §0 holds the
build decisions, §8 the stage order. Read §8 before starting a stage.

## Running it

```bash
pnpm install
cp .env.example .env     # then fill it in
pnpm dev                 # tsx watch, restarts on save
pnpm test                # the self-check — hits real Atlas
pnpm typecheck
```

`http://localhost:4000`. `GET /api/health` reports the process **and** the
database separately, so a server running without Mongo reads as unhealthy
rather than as fine.

## How the frontend reaches it

The apps never call `fetch` themselves. Every screen imports from
`@cfc/mocks`, and each function there begins with one line:

```ts
export async function getServiceAreas(): Promise<string[]> {
  if (isLive("getServiceAreas")) return fetchJson<string[]>("/public/service-areas");
  await latency();                      // the fixture path, still intact
  return applyScenario([...AREAS], []);
}
```

Which functions are live is a per-app env var, so the system runs
half-migrated and each stage is demonstrable as it lands:

```
# cfc-frontend/frontend/apps/*/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_LIVE_APIS=getServiceAreas       # or * for all
```

**No screen file changes when an endpoint goes live.** Where one seems to be
needed, the endpoint shape is wrong — with one exception recorded in
BACKEND-PLAN.md §0.8: the admin write forms were built with save handlers that
only ever called `setState`, so wiring those up is finishing the screen, not
bending it to fit the server.

## Shared types

`@cfc/types` is a `link:` dependency pointing into the frontend workspace, so
both sides compile against the same definitions and the contract cannot drift.
It is the source of truth for every domain shape — and for runtime values the
backend is meant to **port rather than re-derive**: `permission.ts` (all seven
roles, two permission layers), the GST constants, the booking state list.
BACKEND-PLAN.md §9 is firm about this; re-deriving the money rules from the PDF
is how GST ends up charged on the professional's labour.

Two consequences of the link, both deliberate:

- Editing a type in the frontend changes this project's typecheck immediately.
  That is the point.
- This project declares **no `"type": "module"`**. `@cfc/types` declares no
  module type either, so tsx compiles it as CJS; going ESM here puts a
  dual-module boundary between them and `export * from` chains stop
  static-linking across it — `ApiError` silently resolves as `undefined`. This
  cost an hour once; the note is in `package.json` too.

## Layout

```
src/
  index.ts            boot: config → disk → Mongo → listen. Graceful shutdown.
  app.ts              Express assembly. Separate from index.ts so the
                      self-check can mount it without binding a port.
  env.ts              config, read once, refuses to boot on a missing secret
  db.ts               the Mongoose connection
  error.ts            the { status, message, code } envelope + handler
  uploads.ts          the public/private split, and the path guard
  selfcheck.ts        pnpm test
  models/             one file per collection
  routes/             one router per auth scope
```

Route groups follow BACKEND-PLAN.md §3: `/api/public` needs no token, then
`/api/consumer`, `/api/pro` and `/api/admin` behind one RBAC middleware. Which
router a route is mounted on is what decides whether it needs auth — not a
middleware someone has to remember to add.

## Uploads

Two roots, and the split is the whole point:

| Root | Holds | Served |
|---|---|---|
| `uploads/public/` | service images, category icons, banners, job photos | statically at `/uploads/...` |
| `uploads/private/` | **KYC documents** — Aadhaar, PAN, selfies | never; read back only through an authenticated route |

Mongo stores the **relative** path (`/uploads/services/abc.jpg`), never an
absolute URL, so the host can change without a data migration. Each Next app
proxies `/uploads/*` here via a rewrite in its `next.config.js`, which is why
no component needed changing — the apps use plain `<img>` with relative `src`.

An Aadhaar on a guessable public URL is a data-protection incident, and the
only reliable prevention is the file being somewhere the static handler cannot
reach. Not a filename nobody will guess.

`resolveWithin()` **refuses** a suspect path rather than sanitising it. The
first version normalised instead, which is safe but silent: `../public/x.jpg`
quietly became `<root>/public/x.jpg`, so a wrong stored path resolved to a real
neighbouring file and nothing reported a problem. For a KYC document that is
the worst available outcome — the wrong person's Aadhaar, with a 200. The
self-check caught it, which is the whole argument for the self-check.

## What is deliberately not real yet

Per BACKEND-PLAN.md §0.2 and §0.3, waiting on the client:

| Area | Holding behaviour |
|---|---|
| OTP delivery | No SMS until the DLT templates are registered. The flow is real — generated, hashed at rest, expiring, rate limited — and `AUTH_DUMMY_OTP=true` additionally accepts a master code. **Never returned in a response, never logged.** Boot refuses `NODE_ENV=production` with this on. |
| Admin login | Email + password from `.env`. No 2FA, no password reset — the admin UI's 2FA toggle stays visibly unimplemented rather than claiming to be on. |
| Razorpay | No keys, so the endpoint answers 503 `NOT_CONFIGURED` and the UPI/card option renders disabled with its reason. No fake gateway: a stub that auto-succeeds is how an untested signature check reaches production. |
| Cash and wallet | **Real.** Wallet balance derived from an append-only ledger, never a stored counter. |

Each is honest about being unfinished. None pretends.
