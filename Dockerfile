# Node 24: runs .ts sources directly via native type stripping, no build step.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS dev

WORKDIR /usr/src/app

RUN chown node:node /usr/src/app

COPY --chown=node:node package*.json ./

USER node

RUN npm install

COPY --chown=node:node . .

CMD ["npm", "run", "dev:app"]

# -----------------------------------------------------------------------------
# build — produces the browser bundle
# -----------------------------------------------------------------------------
# esbuild is a devDependency, so the bundle has to be built while dev
# dependencies are still installed. Only the output crosses into `prod`, which
# is why that stage can prune without losing the bundle.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# -----------------------------------------------------------------------------
# migrate — one-shot schema migrations
# -----------------------------------------------------------------------------
# node-pg-migrate is a devDependency too, so migrations cannot run from the
# pruned runtime image. Keeping them in their own stage means DDL tooling never
# ships inside the container serving traffic, and gives the migrator its own
# identity to connect as.
FROM build AS migrate

CMD ["npm", "run", "migrate"]

# -----------------------------------------------------------------------------
# fallback — standalone landing page, for keeping the site up during a restart
# -----------------------------------------------------------------------------
# Serves the pre-event curtain, the privacy notice and the terms with no
# database, cache or production secret; see docs/operations/fallback.md. Placed above
# `prod` so a bare `docker build .` still produces the production image.
#
# No `release` stamp: this image is run from a checkout of the same tag
# production runs, and nothing it serves reports a release.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS fallback

WORKDIR /usr/src/app

RUN chown node:node /usr/src/app

COPY --chown=node:node package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

# Tests, snapshots and the browser sources stay out, as in `prod`: the fallback
# serves only the built bundles copied below.
COPY --chown=node:node --exclude=**/*.test.ts --exclude=**/__snapshots__ --exclude=web/client src ./src

COPY --from=build --chown=node:node /usr/src/app/src/web/public/js ./src/web/public/js
COPY --from=build --chown=node:node /usr/src/app/src/web/public/css/dist ./src/web/public/css/dist

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/fallback/server.ts"]

# -----------------------------------------------------------------------------
# release — stamps the commit the image is built from
# -----------------------------------------------------------------------------
# .dockerignore is an allow-list that keeps `.git` out of the build context, so
# compose.prod.yml hands it in as the separate `git-dir` context. Both are
# bind-mounted for this one step and never enter a layer: only the one-line
# /RELEASE file crosses into `prod`. `rw` gives git a scratch copy to refresh
# its index in; BuildKit discards the writes, and the host checkout is never
# touched.
#
# The dirty check compares the working tree with HEAD, and the context lacks
# every tracked file the allow-list leaves out, so its pathspec is limited to the
# paths .dockerignore admits. Keep the two lists in step, or every build reports
# dirty.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS release

RUN apk add --no-cache git

WORKDIR /src

RUN --mount=type=bind,target=/src,rw \
    --mount=type=bind,from=git-dir,target=/src/.git,rw \
    git -c safe.directory=/src -c core.fsmonitor=false \
      describe --tags --always > /RELEASE \
    && if ! git -c safe.directory=/src -c core.fsmonitor=false \
      diff --quiet HEAD -- \
      src migrations scripts 'package*.json' 'tsconfig*.json'; then \
      printf '%s' '-dirty' >> /RELEASE; \
    fi

# -----------------------------------------------------------------------------
# context-check — fails if the build context carries files that must not ship
# -----------------------------------------------------------------------------
# Not part of any runtime image: build it on its own with `npm run
# check:docker-context`. It guards .dockerignore against regressing to a
# deny-list that lets local secrets, logs and tooling state into `COPY` steps.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS context-check

RUN --mount=type=bind,target=/ctx \
    leaked="$(find /ctx \( \
      -name .ignore -o -name logs -o -name .claude -o -name .worktrees \
      -o \( -name '.env*' ! -name '*.example' \) \
      -o -name '*.pem' -o -name '*.key' -o -name 'id_*' \
    \) -print)" \
    && if [ -n "$leaked" ]; then \
      printf 'Build context contains files that must not ship:\n%s\n' "$leaked" >&2; \
      exit 1; \
    fi

# -----------------------------------------------------------------------------
# prod — runtime image
# -----------------------------------------------------------------------------
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS prod

WORKDIR /usr/src/app

# Everything under /usr/src/app stays root-owned (no --chown), so the node process
# that runs it cannot rewrite its own source or dependencies. Only the log
# directory below belongs to node.
COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

# Only what runs: the migrations stay in the `build` and `migrate` stages, and so
# do the CLIs that need the migrator or read-only database role (scripts/admin,
# scripts/db, scripts/survey). .dockerignore excludes both client bundle
# directories, so what ships is what `build` produced rather than whatever
# happened to be on the host. Neither tests (nor their snapshots) nor the browser
# sources (`src/web/client`, nothing on the server imports it) run in production, so
# `COPY --exclude` keeps them out (it needs a Dockerfile frontend that supports it,
# as Docker 29's built-in one does). Patterns are relative to the source.
COPY --exclude=**/*.test.ts --exclude=**/__snapshots__ --exclude=web/client src ./src

# The operator CLIs docs/operations/deployment.md runs with `docker compose exec app`. They
# load the server's configuration, so they live beside it rather than on `migrate`.
COPY --exclude=**/*.test.ts scripts/qr ./scripts/qr
COPY --exclude=**/*.test.ts scripts/telemetry ./scripts/telemetry
COPY --exclude=**/*.test.ts scripts/whatsapp ./scripts/whatsapp

COPY --from=build /usr/src/app/src/web/public/js ./src/web/public/js
COPY --from=build /usr/src/app/src/web/public/css/dist ./src/web/public/css/dist

# Seeds the ownership of the `logs` volume. Docker copies an empty named volume's
# ownership and mode from the image's own directory at the mount point; with no
# directory here the volume arrives owned by root and USER node below cannot write
# to it. Creating it is what makes `read_only: true` and an unprivileged process
# compatible with a durable log file.
RUN mkdir -p /var/log/pelicanpass && chown node:node /var/log/pelicanpass

# The commit this image was built from, read by env.ts so a log line, an alert or
# a client-side stack trace is attributable to a bundle.
COPY --chmod=0644 --from=release /RELEASE ./RELEASE

USER node

# Liveness only: /healthz touches neither Postgres nor Redis, so a database
# blip does not get the container restarted out from under the event.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
