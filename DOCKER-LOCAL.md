# Running the API in Docker, on a laptop

A record of exactly what was done, in order, so it can be torn down and redone
from scratch. Every command here was actually run on 11 Nov 2026 and worked.

**Tear-down is at the bottom.** Run that first if you want a clean slate.

---

## What is running now

| Thing | Name | Where |
|---|---|---|
| Image | `cfc-api:local` | built from `cfc-backend/Dockerfile` |
| API container | `cfc-api` | `localhost:4100` → container's `4000` |
| Mongo container | `cfc-mongo` | internal only, no host port |
| Network | `cfc-net` | how the two find each other |
| Volume | `cfc-mongo-data` | the database files |
| Volume | `cfc-uploads` | KYC documents and job photos |

Port **4100**, not 4000, because something else on this laptop already holds
4000 (`node server.js`, a different project). The container listens on 4000
*inside* itself either way — only the host side moved.

---

## The two mistakes in the first attempt

```
docker build -f cfc-backend/Dockerfile -t cfc-api
ERROR: docker: 'docker buildx build' requires 1 argument
```

**1. Wrong directory.** It was run from inside `cfc-backend/`, where the path
`cfc-backend/Dockerfile` does not exist. Run it from `cfcapp/`.

**2. No build context.** The trailing `.` is missing. That argument is what
Docker is asking for, and it is not optional — see the next section for why it
has to be `.` and not something else.

---

## Why the build context is the parent folder

The **build context** is the folder Docker packages up and sends to itself. The
`Dockerfile` can only `COPY` from inside it. Nothing outside exists as far as
the build is concerned.

This backend depends on the frontend repo:

```json
"@cfc/types": "link:../cfc-frontend/frontend/packages/types"
```

That `../` points *out* of `cfc-backend/`. So the context must be the folder
holding **both** repos:

```
cfcapp/                      ← the build context (the ".")
├── cfc-backend/             ← the Dockerfile lives here
└── cfc-frontend/            ← but this must be copyable too
```

Hence: `-f` says where the Dockerfile is, `.` says what it may copy from.

```bash
cd ~/Desktop/cfcapp
docker build -f cfc-backend/Dockerfile -t cfc-api:local .
```

Took **40 seconds** on a cold cache. A second build after editing a route takes
a few seconds, because the Dockerfile copies `package.json` *before* `src/` —
so changing source code does not re-run `pnpm install`.

---

## The flow

```
  Dockerfile  ──docker build──▶  image (cfc-api:local)
                                    │
                                    └──docker run──▶ container (cfc-api)
                                                        │
  ┌─────────────────────── network: cfc-net ────────────┼──────────┐
  │                                                     │          │
  │   container cfc-api ──"cfc-mongo:27017"──▶ container cfc-mongo │
  │          │                                          │          │
  └──────────┼──────────────────────────────────────────┼──────────┘
             │                                          │
      volume cfc-uploads                       volume cfc-mongo-data
      (/data/uploads)                          (/data/db)
             │
      host port 4100 ──▶ container port 4000
```

Three ideas doing the real work:

**Network.** Containers on the same network reach each other **by container
name**. `cfc-mongo` is a hostname. This is why the connection string is
`mongodb://...@cfc-mongo:27017` and not `localhost` — inside a container,
`localhost` is *that container*, so `localhost:27017` would mean "a Mongo
running inside the API container", which there isn't.

**Volume.** Everything a container writes dies with it, *except* what is on a
volume. `cfc-mongo-data` and `cfc-uploads` are why `docker rm` does not destroy
the database or the uploaded KYC documents.

**Port publishing.** `-p 4100:4000` is `host:container`. Without it the API is
unreachable from the laptop even though it is running fine.

---

## Step 1 — build the image

```bash
cd ~/Desktop/cfcapp
docker build -f cfc-backend/Dockerfile -t cfc-api:local .
docker images | grep cfc-api        # confirm it exists
```

`-t cfc-api:local` is `name:tag`. The tag is a label, not a version number —
`:local` is a reminder that this one is not for the server.

---

## Step 2 — create the network

```bash
docker network create cfc-net
```

One command, and the reason it exists is the whole of the "Network" note above.

---

## Step 3 — start Mongo

```bash
docker run -d --name cfc-mongo --network cfc-net \
  -e MONGO_INITDB_ROOT_USERNAME=cfc \
  -e MONGO_INITDB_ROOT_PASSWORD=devpassword \
  -v cfc-mongo-data:/data/db \
  mongo:7
```

| Flag | Why |
|---|---|
| `-d` | detached — runs in the background |
| `--name cfc-mongo` | so it has a hostname other containers can use |
| `--network cfc-net` | puts it on the shared network |
| `-e MONGO_INITDB_*` | creates the root user on **first** start only |
| `-v cfc-mongo-data:/data/db` | the data survives removing the container |
| `mongo:7` | pulled from Docker Hub. No Mongo installed on the laptop |

**No `-p`.** Deliberate: only the API needs to reach the database, and a Mongo
port exposed to a network is found and wiped within hours. To get a shell:

```bash
docker exec -it cfc-mongo mongosh -u cfc -p devpassword --authenticationDatabase admin
```

---

## Step 4 — run the API

```bash
docker run -d --name cfc-api --network cfc-net -p 4100:4000 \
  -v cfc-uploads:/data/uploads \
  -e NODE_ENV=staging -e PORT=4000 \
  -e MONGODB_URI='mongodb://cfc:devpassword@cfc-mongo:27017/cfc?authSource=admin' \
  -e JWT_SECRET='local-docker-jwt-secret-not-for-production-use' \
  -e BANK_ENCRYPTION_KEY='local-docker-bank-key-not-for-production-use' \
  -e SUPER_ADMIN_EMAIL='admin@cfcservice.in' \
  -e SUPER_ADMIN_PASSWORD='5O1Sc4XfWf6-' \
  -e AUTH_DUMMY_OTP=true -e AUTH_MASTER_OTP=123456 \
  -e CORS_ORIGINS='http://localhost:3000,http://localhost:3001,http://localhost:3002' \
  cfc-api:local
```

The three that are easy to get wrong:

**`MONGODB_URI` uses `cfc-mongo`,** the container name. See the Network note.
`authSource=admin` is needed because the root user lives in the `admin`
database, not in `cfc`.

**`NODE_ENV=staging`, never `production`.** `src/env.ts` refuses to boot with
`NODE_ENV=production` while `AUTH_DUMMY_OTP=true`. That guard is deliberate —
the master OTP signs in as *any* phone number, so it must never reach a real
deployment. The error, if you try it, is explicit about why.

**`-v cfc-uploads:/data/uploads`** matches the `ENV UPLOAD_ROOT=/data/uploads`
in the Dockerfile. Leave it out and every KYC document and job photo is
destroyed the next time the container is replaced.

The secrets above are throwaway strings for a laptop. Real ones belong in
`deploy/.env` on the server, never in a shell command — a `-e SECRET=...` ends
up in your shell history and in `docker inspect`.

---

## Step 5 — verify

```bash
docker ps                      # both containers Up?
docker logs cfc-api            # what the server said on boot
curl http://localhost:4100/api/health
```

What a working boot looks like:

```
[boot] configuration { nodeEnv: 'staging', port: 4000,
       mongo: 'mongodb://<redacted>@cfc-mongo:27017/cfc?authSource=admin', … }
[boot] mongo connected
[boot] listening on http://localhost:4000
```

`listening on http://localhost:4000` is the *container's* view. From the laptop
it is 4100.

Three checks that each prove something different:

```bash
# 1. the process and the database are both alive
curl http://localhost:4100/api/health
# {"ok":true,"db":"connected","env":"staging"}

# 2. routing and JSON work, with no token
curl http://localhost:4100/api/public/config

# 3. JWT signing and super-admin seeding work
curl -s -X POST http://localhost:4100/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@cfcservice.in","password":"5O1Sc4XfWf6-"}'
# → { "token": "eyJhbGciOi…" }
```

That third one is the real proof: a token comes back, which means the server
wrote the super-admin into a brand-new empty database and signed a JWT.

**The database is empty.** It is a fresh Mongo container, not the Atlas
cluster `.env` points at. No services, no pros, no bookings. That is on purpose
— a container pointed at Atlas would be writing to real data. To use Atlas
instead, swap one flag and drop the Mongo container entirely:

```bash
-e MONGODB_URI='mongodb+srv://…your Atlas string…'
```

---

## Step 6 — look inside a container

The command that makes Docker stop feeling like magic:

```bash
docker exec -it cfc-api sh
```

```sh
ls /app/cfc-backend/src      # your source, inside the image
ls /data/uploads             # the mounted volume
node -v                      # v22 — the image's Node, not the laptop's
env | grep MONGODB_URI
exit
```

A tiny Alpine Linux with nothing in it but this app. That isolation is the
point: the laptop's Node version and the container's are unrelated.

---

## Useful commands

```bash
docker ps                          # running containers
docker ps -a                       # including stopped ones
docker images                      # images on disk
docker volume ls                   # volumes
docker network ls                  # networks

docker logs cfc-api                # all logs
docker logs -f cfc-api             # follow live, Ctrl-C to stop watching
docker logs --tail 50 cfc-api      # last 50 lines

docker stop cfc-api                # stop (keeps the container)
docker start cfc-api               # start it again
docker restart cfc-api             # stop + start
docker rm cfc-api                  # delete the container (must be stopped)

docker stats                       # live CPU and memory per container
docker exec -it cfc-api sh         # shell inside
```

### After changing code

The image is a frozen copy of `src/`. Editing a file on the laptop changes
nothing inside a running container:

```bash
cd ~/Desktop/cfcapp
docker build -f cfc-backend/Dockerfile -t cfc-api:local .
docker rm -f cfc-api
# then re-run the Step 4 command
```

This is the one place Docker is worse than `pnpm dev` for day-to-day work. For
writing code, keep using `pnpm dev`; use Docker to check that the thing you are
about to deploy actually boots.

---

## Errors, and what they actually mean

| Message | Cause |
|---|---|
| `requires 1 argument` | the trailing `.` is missing |
| `failed to read dockerfile` | run from `cfcapp/`, not `cfc-backend/` |
| `port is already allocated` | something else holds the host port — change `-p 4101:4000` |
| `name is already in use` | a container of that name exists. `docker rm -f cfc-api` |
| health says `"db":"disconnected"` | wrong `MONGODB_URI`, or not on `cfc-net`. `docker logs cfc-api` |
| `ENOTFOUND cfc-mongo` | the two containers are not on the same network |
| `AUTH_DUMMY_OTP … production` | `NODE_ENV=production` with the dummy OTP on. Use `staging` |
| `EUNSUPPORTEDPROTOCOL` | npm was used instead of pnpm. `link:` is pnpm-only |
| `Cannot GET /api/health` | something *else* is on that port, not this API |

---

## Tear it all down

To get back to nothing and redo it yourself:

```bash
# containers
docker rm -f cfc-api cfc-mongo

# network
docker network rm cfc-net

# volumes — THIS DELETES THE DATABASE AND THE UPLOADS
docker volume rm cfc-mongo-data cfc-uploads

# the image
docker rmi cfc-api:local

# confirm
docker ps -a | grep cfc-      # nothing
docker volume ls | grep cfc-  # nothing
```

Leave the two `docker volume rm` lines out if you want to keep the data and
only rebuild the containers.

---

## The same thing with compose

Eight `-e` flags on one line is the reason `docker compose` exists. Everything
above is already encoded in `deploy/docker-compose.yml`:

```bash
cd ~/Desktop/cfcapp/deploy
cp .env.example .env            # then fill it in
docker compose up -d --build api mongo
docker compose ps
docker compose logs -f api
docker compose down             # stop; volumes kept
docker compose down -v          # stop AND delete the volumes
```

Naming `api mongo` starts only those two. With no names it starts all six —
including Caddy, which wants ports 80/443 and real domains, which is not what a
laptop has. Compose also creates the network and the volumes for you, and
`depends_on: condition: service_healthy` makes the API wait until Mongo is
actually answering rather than merely started.

Learn the raw commands first anyway. Compose hides the network, the volumes and
the port mapping, and those three are what every Docker problem turns out to be.

---

## Doing the frontend yourself

`cfc-frontend/frontend/Dockerfile` already exists. Three differences from the
backend, and the second one catches everybody:

1. **The context is `cfc-frontend/frontend`,** not the parent — the frontend
   does not depend on the backend, so it needs no `../`.
2. **`NEXT_PUBLIC_*` values are build args, not runtime env.** Next.js compiles
   them into the JavaScript bundle. Changing one needs a `--build`; a
   `docker restart` keeps serving the old value. `docker-compose.yml` shows
   this under the `consumer:` service — `args:`, not `environment:`.
3. **One image, three containers.** Consumer, pro and admin are the same build
   run with different `command:` values. Look at the `&frontend` anchor and the
   `<<: *frontend` lines in the compose file.
