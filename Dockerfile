# syntax=docker/dockerfile:1

# The CFC API.
#
# ## Why the build context is the PARENT folder
#
# This repo depends on the frontend one:
#
#   "@cfc/types": "link:../cfc-frontend/frontend/packages/types"
#
# That is a symlink pointing out of this repo. The relative path has to resolve
# inside the image exactly as it does on a laptop, so both repos are copied in
# side by side and the build is run from the folder that holds them both:
#
#   docker build -f cfc-backend/Dockerfile -t cfc-api .     # run from cfcapp/
#
# ## Why pnpm and not npm
#
# `link:` is a pnpm-only protocol. `npm install` fails outright on it with
# EUNSUPPORTEDPROTOCOL — not a warning, no install at all.
FROM node:22-alpine

RUN npm install -g pnpm@10.20.0

WORKDIR /app

# Manifests first, source later: editing a route then rebuilds in seconds
# instead of reinstalling every dependency.
COPY cfc-frontend/frontend/packages/types/package.json /app/cfc-frontend/frontend/packages/types/
COPY cfc-backend/package.json cfc-backend/pnpm-lock.yaml /app/cfc-backend/

WORKDIR /app/cfc-backend

# Dev dependencies are kept ON PURPOSE. The server runs straight from
# TypeScript via tsx (`pnpm start`), and tsx is a devDependency — a
# `--prod` install produces an image that cannot start.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY cfc-frontend/frontend/packages/types/src /app/cfc-frontend/frontend/packages/types/src
COPY cfc-backend/tsconfig.json ./
COPY cfc-backend/src ./src

# NODE_ENV is deliberately NOT set here — it is passed in from the compose
# file, because setting it to `production` makes the server refuse to boot
# while AUTH_DUMMY_OTP is still true. See deploy/DEPLOY.md, "Before you go
# truly live".
EXPOSE 4000

# Uploads live here. Mount a volume on it or every KYC document and job photo
# is destroyed on the next deploy.
ENV UPLOAD_ROOT=/data/uploads

CMD ["pnpm", "start"]
