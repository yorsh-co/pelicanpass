# Deployment

Deploying `pelicanpass` to a production host. Written to be followed top to
bottom on a fresh machine.

Companion documents:

- [`container-containment.md`](../infrastructure/container-containment.md) — keeping a compromised container off the
  host and the LAN
- [`db-cheatsheet.md`](./db-cheatsheet.md) — psql access, seeding, migration commands
- [`imports.md`](./imports.md) — loading the roster and volunteer permissions from CSV
- [`security-overview.md`](../security/security-overview.md) — what is hardened, and the pre-event checklist

---

## The stack

```
Internet ──▶ Cloudflare edge ──▶ (outbound tunnel) ──▶ cloudflared ──▶ caddy :80   ──▶ app ──▶ db
Tailnet  ──▶ tailscale serve (vpn sidecar) ─────────────────────────▶ caddy :8080 ──┘    └──▶ cache
```

Seven services on five networks, split by trust boundary (`migrate` runs only under the `tools`
profile):

| Service                | Networks                    | Reachable from       |
| ---------------------- | --------------------------- | -------------------- |
| `tunnel` (cloudflared) | `edge`, `egress`            | —                    |
| `vpn` (tailscale)      | `edge`, `egress`            | tailnet devices      |
| `proxy` (caddy)        | `edge`, `web`               | tunnel, vpn          |
| `app`                  | `web`, `app-egress`, `data` | proxy                |
| `migrate`              | `data`                      | — (`tools` profile)  |
| `db`, `cache`          | `data` _(internal)_         | app and migrate only |

**Nothing publishes a host port.** Public ingress arrives through the Cloudflare Tunnel, which is an
_outbound_ connection from the `tunnel` container; the tailnet path arrives through the `vpn`
sidecar, which likewise dials out. `edge`, `web` and `data` are `internal: true` and only `egress` (`tunnel` and `vpn`) and `app-egress` (`app` alone) have a
gateway: `proxy` has no route out, a compromised connector has no route to `app:3000`, and Postgres and Redis have no route off the host at all — that is what stops anyone holding `TUNNEL_TOKEN` from routing
straight at the database.

**`edge` is pinned to `172.30.0.0/24`** in production and `172.31.0.0/24` in development, unlike
the other two networks, which take whatever Docker's default pool offers. The `Caddyfile` trusts
that subnet in `trusted_proxies` and in a 403 gate, so it has to be a fact rather than an accident —
it is what makes cloudflared the only source Caddy will accept a client IP from. The two stacks use
different ranges so they can run on one host together. Confirm nothing else on the host already
holds yours:

```bash
docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

If it collides, set `EDGE_SUBNET` and `VPN_IP` in `.env`. Each compose file names both values once,
on the `x-edge-subnet` and `x-vpn-ip` anchors, and the network, the Tailscale sidecar and the
`Caddyfile` all read from there — nothing else needs editing. Read the constraints in the Network
section of `.env.example` first: the subnet is a trust boundary, and widening it lets the app
container choose its own client IP. The public hostname reaches the `Caddyfile` the same way, from
`SITE_HOST`.

---

## Which compose file runs

`compose.prod.yml` is **never** loaded automatically. Compose only auto-discovers `compose.yaml`,
`compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, plus a `compose.override.yml` if one
exists. So a bare `docker compose` resolves to the **development** file.

That default is deliberate — production should require an explicit act, not happen by accident. But
typing `-f compose.prod.yml` on every command is a footgun in the other direction: `docker compose
logs app` on the production host would show you the dev project and report nothing.

**Set it once, in the production `.env`:**

```bash
COMPOSE_FILE=compose.prod.yml
```

Compose reads its own settings — `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES` — from
the `.env` file in the project directory, not just interpolation variables. After that, bare
`docker compose up -d`, `logs`, `ps` all target production, and an explicit `-f` still overrides.

Prefer this over the alternatives:

- **A shell export** is per-user and per-shell. systemd units, cron jobs, a second admin's session
  and `ssh host 'docker compose ps'` all miss it.
- **Renaming the file** puts the working tree permanently at odds with the repository, and the next
  `git pull` fights it. It also makes `compose.yml` mean different things on different machines.

Multiple files separate with `:` (`COMPOSE_FILE=a.yml:b.yml`), configurable via
`COMPOSE_PATH_SEPARATOR`.

### Project isolation

`compose.prod.yml` declares `name: pelicanpass-prod`, so every container, volume and network is
namespaced separately from the dev project (`pelicanpass`).

- The two stacks cannot collide, and **do not share a database**.
- `docker compose down` is scoped to one project — it cannot tear down the other.
- Equally: `docker compose down -v` destroys _that project's_ `data` volume. There is no
  cross-project safety net, so read the command before running it.

### Development and production on one host

Both stacks can run on the same machine at once. Each lives in **its own checkout**, with its own
`.env`:

```
/srv/dev/pelicanpass    working branches      .env → development values
/srv/prod/pelicanpass   a release tag         .env → production values, COMPOSE_FILE=compose.prod.yml
```

The directory is what selects the environment. Nothing that differs between them is committed —
the domain, the network ranges and every credential come from `.env` — so the production checkout
never needs a branch of its own, a merge or a rebase.

**Clone production from `origin`, not as a worktree of the dev checkout.** A worktree's `.git`
points back into the dev directory, and cloning from the remote means production can only run
code that has been pushed. Deploy tagged releases, never a branch — see
[Updating a running deployment](#updating-a-running-deployment).

**`compose.prod.yml` builds from, and bind-mounts, its own working tree.** That is why production
cannot share the dev checkout: `Caddyfile`, `tailscale/` and `scripts/db/init` are mounted from it,
and `app` is built from it, so a shared tree would ship whatever was half-edited in development.

The networks do not collide: development takes `172.31.0.0/24` and `br-ppdev-*`, production keeps
`172.30.0.0/24` and `br-pp*`. Volumes, containers and project names were already separate.

**What must never be shared.** Each stack needs its own identity in every external system:

- **`TUNNEL_TOKEN`** — a separate Cloudflare tunnel per stack. Two stacks running one tunnel's token
  become two connectors of the same tunnel, and Cloudflare load-balances between them: production
  traffic lands on the development stack. This is the most dangerous misconfiguration here, and
  nothing on the host reports it.
- **`TS_AUTHKEY`, `TS_HOSTNAME`, `ADMIN_URL`** — a separate tailnet node per stack. A duplicate
  hostname gets a silent `-1` suffix, and `ADMIN_URL` then fails the same-origin check.
- **Every credential** — `PASS_SECRET`, `ADMIN_PASSWORD_PEPPER`, the database and Redis passwords,
  the WhatsApp token. None shared means a development leak is never a production leak.

**The limit this does not remove:** both stacks run under one rootless daemon and one user. Anything
that can reach that daemon from the development side can `docker exec` into production. On an
event host, stop the development stack for the event window.

#### Which stack am I on?

- **At a shell** — `pwd` is the answer: the checkout is the environment. `docker compose ls` lists
  both projects with the path of each one's compose file, and container names differ too:
  `pelicanpass-app` is production, `pelicanpass-app-1` is development.
- **What is running** — the release the app reports, not what is checked out:

  ```bash
  curl -s https://<tailnet-name>/readyz | jq .release
  docker compose exec app cat RELEASE
  ```

  The same value is on every "Application started" alert and on `<html data-release>` in any page.

  | `release`             | Means                                                   |
  | --------------------- | ------------------------------------------------------- |
  | `dev`                 | The development stack                                   |
  | `v0.1.0`              | Production, on a clean tag                              |
  | `v0.1.0-3-gabc1234`   | Production built off a tag — not a release              |
  | `…-dirty`             | Production built with local edits in its checkout       |

- **What is checked out** — `git describe --tags` in the checkout. If it differs from what `/readyz`
  reports, the checkout moved and the image was not rebuilt.

---

## First deploy

### 1. Prepare the host

Work through [`container-containment.md`](../infrastructure/container-containment.md) §9 first. In short: rootless
Docker, the container egress filter, no published ports.

```bash
docker info --format '{{.SecurityOptions}}'   # expect name=rootless
```

**Size the host by measurement.** The app is one Node process, so single-thread speed sets its
ceiling more than core count or memory. The 2026 event's host, a four-core Xeon E3-1220 v5 with
8 GB, carried 3,500 users comfortably on the raffle; the figures and what they leave out are in
[`load-testing.md`](../performance/load-testing.md#what-the-numbers-mean-for-an-event). Those numbers belong to
that host: a new one gets its own capacity session before the event, from
[First session on a new host](../performance/load-testing.md#first-session-on-a-new-host). On the event host, set
the firmware's power profile to performance and the CPU governor to `performance`; the load test
does not reach the network, so confirm the uplink's negotiated speed with `ethtool` as well.

**Measure the release before the code freeze.** Published figures describe the code that was
measured, so once the release commit is chosen, run raffle and survey capacity and raffle past the
knee on the event host at that commit
([A full session, from scratch](../performance/load-testing.md#a-full-session-from-scratch), steps 1 to 3 and 6 to 9;
runs 1 to 3 can be skipped when the limiters have not changed).
Run from a clean clone: `git status --short` prints nothing, and an `npm ci` that rewrote
`package-lock.json` is restored first, or every row is recorded as dirty. Commit the session and
regenerate the report, so the README's capacity figures and the event match.

### 2. Clone and configure

```bash
git clone https://github.com/yorsh-co/pelicanpass.git
cd pelicanpass
cp .env.example .env
```

Edit `.env`. Beyond the values it documents, production specifically needs:

| Variable            | Value                             | Why                                                                                                  |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`      | `compose.prod.yml`                | So bare `docker compose` targets production                                                          |
| `NODE_ENV`          | `production`                      | `logger.ts` only loads `pino-pretty` outside production, and that package is not in the pruned image |
| `POSTGRES_PASSWORD` | ≥12 chars, not a known-weak value | Enforced at boot by `env.ts`, production only                                                        |
| `REDIS_PASSWORD`    | same                              | same                                                                                                 |
| `APP_URL`           | the public hostname               |                                                                                                      |
| `SITE_HOST`         | the same hostname, bare           | The site address Caddy answers on. No scheme — it is the host half of `APP_URL`, and the two must agree |
| `SERVER_NAME`       | this machine's label              | Named in the proxy's internal status response. The same label as the load test's `--host`. Optional; unset reads as `unnamed` |
| `CHECKIN_SESSION_TTL` | `900` or lower | The privacy notice states 15 minutes for the check-in session |
| `ATTENDEE_SESSION_TTL` | `86400` | The privacy notice states 24 hours for the attendee session |
| `PASS_SECRET`       | `openssl rand -hex 32`            | Signs the rotating band and every pass token. Enforced at boot in **every** environment, not just production |
| `ADMIN_PASSWORD_PEPPER` | `openssl rand -hex 32`, **its own** | Mixed into every admin password before hashing. Enforced in every environment, and boot refuses if it equals `PASS_SECRET` |
| `PASS_BAND_ENABLED` | `true`                            | Whether the pass carries the rotating band. Defaults to `true`. Scanning is unaffected either way — a scanned pass stands on its signed token. `false` drops the eyes-only comparison, which is the only freshness check on the broken-camera `/lookup` path, and leaves both screens showing a clock |
| `PASS_BAND_LANGUAGE` | `pt-BR`                          | Language of the band's word, `pt-BR` or `en`; any other value stops the boot. One value for the whole deployment, whatever the page language, because the attendee's pass and the volunteer's screen are compared by eye and must show the same word. Defaults to `pt-BR` |
| `LANDING_ENABLED`   | `true`                            | Stands the pre-event landing page in front of the app until check-in opens. Defaults to `false` |
| `EVENT_START_AT`    | ISO-8601 **with offset**          | Both check-in windows are measured back from it. Required when `LANDING_ENABLED=true` |
| `EVENT_CLOSES_AT`   | ISO-8601 **with offset**          | From this instant the public pages show the closing page and the attendee API answers `410 EVENT_CLOSED`; `/admin` stays open. Optional, independent of `LANDING_ENABLED`. Boot refuses it before `SURVEY_CLOSES_AT` or at/before `EVENT_START_AT`. Copy the same line to the fallback's `.env` |
| `TURNSTILE_ADMIN_SITE_KEY` | the admin widget's site key | A second Turnstile widget for the sign-in form, not the attendee one: keys carry their own hostname allowlist and this form answers on two hostnames. Required in every environment |
| `TURNSTILE_ADMIN_SECRET` | its secret | same |
| `TURNSTILE_ADMIN_ENFORCE` | `true` | Whether a missing or refused token turns a sign-in away. Defaults to `true`. Set `false` and recreate the app (`docker compose up -d --force-recreate app`) to stop enforcing during a Turnstile outage — sign-in then stands on Cloudflare Access and the password alone |
| `CF_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` | The full team hostname: both the JWKS host and the token's `iss`. Optional, but while it or the AUD is empty the origin refuses every admin request that did not arrive over the tailnet |
| `CF_ACCESS_AUD`     | the application's Audience tag     | The check that tells this application's tokens from anything else behind Access on the same team domain, which would otherwise pass signature and issuer |
| `RATE_LIMIT_OVERRIDES` | empty                           | Per-limiter quota overrides, `prefix=points/duration`, for the night only. Empty means the defaults in `src/config/rate-limits.ts`. An invalid entry refuses boot; see [`rate-limiting.md` § Overriding a quota](../performance/rate-limiting.md#overriding-a-quota) |
| `LOG_FILE_DIR`      | `/var/log/pelicanpass`               | The `logs` volume's mount. The `.env.example` value is repo-relative and fails at boot on the read-only container; empty disables the durable log entirely |
| `DISCORD_WEBHOOK_URL` | a Discord channel webhook       | Where alerts go. Empty delivers nothing, silently — the rules still run and log |
| `DISCORD_WEBHOOK_URL_CRITICAL` | a second channel's webhook | Optional. `critical` alerts only; falls back to the one above |
| `ALERT_ENABLED`     | `true`                            | Master switch for delivery. `false` for a rehearsal, `true` before the doors |

**`EVENT_START_AT` must carry its UTC offset** — `2026-09-13T19:00:00-03:00`,
not `2026-09-13T19:00:00`. Neither compose file sets `TZ`, so the container runs
UTC and an offsetless value opens the windows three hours off. Boot refuses one
without an offset rather than letting the queue discover it.

**`SITE_HOST` is why the `Caddyfile` is the same file in both environments.** It is
substituted into the public vhost's site address when Caddy adapts its config, so the
domain is a `.env` value rather than a committed one. Bare hostname only — the scheme
is already written in the `Caddyfile`. Both compose files declare it
`${SITE_HOST:?...}`, so an unset or empty value stops `docker compose` before anything
starts — Caddy cannot catch it itself, because an empty substitution leaves the site
address as `http://`, a valid catch-all on `:80` that would answer any Host header.
Caddy reads the value once, at config load, so a change needs
`docker compose up -d --force-recreate proxy`; a `restart` or a `caddy reload` keeps the
old value.

The two offsets default to `30m` for participants and `4h` for volunteers, which
is the intended shape; set `CHECKIN_OPENS_BEFORE_PARTICIPANT` /
`CHECKIN_OPENS_BEFORE_VOLUNTEER` only to change it. `EVENT_TIMEZONE` defaults to
`America/Sao_Paulo` and is what the landing page prints the open time in.

Leave `LANDING_BYPASS_TOKEN` **empty** for the event. It exists so a rehearsal
can open the real flow during a closed window; a key still set on the day is a
way past the curtain that nobody is tracking.

**`PASS_SECRET` is fixed for the duration of the event.** Changing it
invalidates every live pass at once — every band stops matching the volunteers'
screens and every unspent token fails to verify. Treat it like `EVENT_ID`. And
because it lives in `.env`, a change needs
`docker compose up -d --force-recreate app`, never `restart`: the container's
environment is baked in at *creation*.

**`ADMIN_PASSWORD_PEPPER` is backup-critical.** It is the half of every
administrator password that is not in Postgres, which is what makes a stolen
database useless — and it is also the half that cannot be recovered from one.
Losing or changing it locks out every administrator at once, and no amount of
database access will undo that: nothing can re-derive a hash without the
original password. Recovery is setting every password again by hand with
`scripts/admin/set-admin-password.ts`.

Back it up wherever `PASS_SECRET` is backed up, and generate it *separately* —
boot refuses if the two are equal, because rotating either would otherwise
silently break the other. Same `--force-recreate` rule applies.

`env.nodeEnv` defaults to `production` when unset, so the failure mode is safe — but set it
explicitly rather than relying on that.

**Alerts reach you only through Discord, so set that up now rather than on the day.** In the
channel's settings → Integrations → Webhooks → _New Webhook_, copy the URL into
`DISCORD_WEBHOOK_URL`. Worth a second channel: point `DISCORD_WEBHOOK_URL_CRITICAL` at one with
phone notifications on, and leave warnings in a quiet one. Nothing else is involved — no agent on
the host, and nothing leaves it but the alert text, which is scrubbed of personal data at the
boundary. Once the stack is up (step 6), prove
delivery with the smoke script against a scratch channel:

```bash
docker compose exec app node scripts/telemetry/smoke.ts
```

Expect exactly two messages, not fifty-one: the burst of identical firings collapses into one,
and the other shows its name, phone and ticket fields as `[REDACTED]`. Anything else means the
dispatcher or the scrubber is wrong, and you want to know that before the doors open. What each alert means,
and what to do about it, is in [_Watching the event_](#watching-the-event--alerts-the-panel-and-what-to-do).

**Four database credentials, not one.** `.env.example` documents each; the split exists because
`POSTGRES_USER` used to do two incompatible jobs at once.

| Variable                               | Role                | Job                                                       |
| -------------------------------------- | ------------------- | --------------------------------------------------------- |
| `POSTGRES_SUPERUSER` / `_PASSWORD`     | `postgres`          | Initialises the container. Nothing connects with it later |
| `POSTGRES_USER` / `POSTGRES_PASSWORD`  | `pelicanpass_app`      | What the application connects as                          |
| `POSTGRES_MIGRATOR_USER` / `_PASSWORD` | `pelicanpass_migrator` | Owns the schema, runs migrations                          |
| `POSTGRES_READONLY_USER` / `_PASSWORD` | `pelicanpass_readonly` | Browsing credential for psql or a GUI                     |

Generate all four with `openssl rand -hex 24`. **They must be `[A-Za-z0-9]` only** — the migration
command assembles a `DATABASE_URL` by string interpolation, so `@ : / # ?` breaks it.

Keep `.env` at mode `0600`. It carries `TUNNEL_TOKEN`, which is a database-exposure credential:
tunnels are configured server-side from the Cloudflare dashboard, so anyone holding it can publish
new routes without touching this host.

### 3. Build

```bash
docker compose build
```

The build runs `git describe --tags --always --dirty` against the checkout and stamps the result
into the image as `RELEASE`. That value is what `/readyz`, the startup alert, the logs and client
error reports name as the release. On a tag checkout it reads as the tag, `v0.1.0`. A `-g<sha>`
suffix means the checkout is not on a tag, and `-dirty` means it has local edits — production
should show neither.

`compose.prod.yml` passes `.git` to the build as a separate `git-dir` context, so the checkout must
be a clone: in a git worktree `.git` is a file and the build fails. `.dockerignore` is an allow-list
(`src`, `migrations`, `scripts`, `package*.json`, `tsconfig*.json`), and the dirty check looks only at
those paths: a tracked file outside them never makes a build `-dirty`, and a new top-level path the build needs must be
added to both. `npm run check:docker-context` builds the `context-check` stage, which fails if the context carries
`.ignore`, `logs`, `.claude`, `.worktrees`, a `.env*` that is not `*.example`, or a `*.pem`, `*.key` or `id_*` file;
it needs Docker, so it is not part of `npm run check`.

Four image stages, driven by two devDependencies:

| Stage     | Purpose                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `dev`     | Development only — `node --watch`, esbuild watch, bind mount                           |
| `build`   | Installs all dependencies and produces the browser bundle (esbuild is a devDependency) |
| `migrate` | Inherits `build`, keeps `node-pg-migrate`, runs schema migrations                      |
| `prod`    | `npm ci --omit=dev`, `src` and the bundle from `build` (root-owned), `USER node`, `HEALTHCHECK`            |

### Updating pinned images

Every `image:` in the compose files and every `FROM` in the `Dockerfile` is written
`name:tag@sha256:<index digest>`. The tag is for the reader and the digest is what Docker pulls, so
nothing changes until someone edits the line. `scripts/compose/image-pins.test.ts` (part of
`npm test`) fails on any reference without a digest.

To bump one:

1. Pick the new tag and read the upstream release notes.
2. Resolve its index digest without pulling it:

   ```bash
   docker buildx imagetools inspect caddy:2.11.8 | grep '^Digest:'
   ```

3. Replace the tag and digest together in every file that names the image (`grep -rn 'caddy:' compose*.yml Dockerfile`).
   The five `FROM` lines in the `Dockerfile` share one Node digest. Postgres, Redis and Caddy are
   also named in `scripts/standby/lib.sh`, `scripts/db/export-results.test.ts` and
   `scripts/caddyfile.test.ts`; keep them on the same reference as Compose.
4. Rebuild (`docker compose build`) and recreate (`docker compose up -d`), then re-run the
   [Verification](#verification) pass and the container checks in
   [`container-containment.md`](../infrastructure/container-containment.md) before the event.
5. Commit the new references with the release notes link in the message.

### 4. Start the database and let it provision its roles

```bash
docker compose up -d db
docker compose logs db | grep 01-roles
```

Expect `01-roles.sh: provisioned pelicanpass_app, pelicanpass_migrator, pelicanpass_readonly`. The `postgres`
image runs `scripts/db/init/01-roles.sh` from `/docker-entrypoint-initdb.d` once, on a freshly
initialised data directory — which is exactly the case on a new host. **Ordering is not optional:
the migrator role has to exist before the next step can connect at all.**

The script validates its inputs and stops on the first error, so a weak or wrongly-shaped password
fails here rather than silently leaving a role uncreated. If the volume already exists — you are
adopting this scheme on a running database, or you rotated a password — the image skips init and you
run it yourself:

```bash
docker compose exec db sh /docker-entrypoint-initdb.d/01-roles.sh
```

It is idempotent.

### 5. Migrate

```bash
docker compose --profile tools run --rm --build migrate
```

`--build` is what makes this run the migrations in the checkout. `migrate` sits behind the `tools`
profile, so `docker compose build` never rebuilds it, and `run` without `--build` reuses the image
it built last. On an update that image predates any new migration: it reports nothing to run, and
the app starts against a schema it does not match.

The same service runs the operator CLIs that need the migrator or read-only database role
(`scripts/admin/*`, `scripts/db/import-attendees.ts`, `scripts/db/set-volunteer-permissions.ts`,
`scripts/survey/export-csv.ts`). It holds those credentials and none of the server's secrets, and the server holds none of them:

```bash
docker compose run --rm migrate node scripts/admin/list-admins.ts
docker compose run --rm -T migrate node scripts/db/import-attendees.ts < roster.csv   # -T when stdin is piped
```

`run` replaces the image's default command (`npm run migrate`) with what follows the service name,
since the image has no entrypoint, and allocates a terminal unless `-T` is given, which the password
prompts of `create-admin.ts` and `set-admin-password.ts` need. `run` reuses the last built image, so
add `--build` after a pull. `scripts/qr/urls.ts`, `scripts/whatsapp/send-test.ts` and
`scripts/telemetry/*` load the server's configuration and stay on `docker compose exec app`; the
production image copies those three directories and nothing else under `scripts/`, so any other
script runs on `migrate`. The survey export connects as the read-only role, which reads answers the application role cannot, so
only `migrate` holds those keys.

The migrator is behind a profile so `up` never starts it. It needs its own image because
`node-pg-migrate` is a devDependency and the runtime image is pruned — which also keeps DDL tooling
out of the container serving traffic. It connects as `pelicanpass_migrator`, which owns the schema; the
application's credential cannot run DDL.

Migration `005` applies the column-level grants that make `pelicanpass_app` usable, so the application
will fail every query until this step has run — not just on a schema mismatch.

Migration `006` backfills `event_id` from `EVENT_ID` and makes it `NOT NULL`. It throws if the
variable is unset, so a misconfigured `.env` stops here rather than at the door.

Migrations must run **in a container**: `data` is `internal: true`, so `db` does not resolve from
the host.

### 6. Start

```bash
docker compose up -d
docker compose ps
```

---

## Verification

Run all of these before pointing anyone at the URL.

```bash
HOST=<your-host>    # the public hostname, as in SITE_HOST

# 1. No published ports anywhere
#    Ports lists EXPOSEd ports too (6379/tcp, 5432/tcp, 80/tcp…); only a
#    host binding carries `->`, as in 0.0.0.0:6379->6379/tcp.
docker compose ps --format '{{.Name}} {{.Ports}}' | grep -- '->'   # no output

# 2. The app runs unprivileged with a baked-in bundle
docker compose exec app id                                  # uid=1000(node)
docker compose exec app ls src/web/public/js                # populated

# 3. cloudflared cannot reach the data tier — the point of the segmentation
docker run --rm --network pelicanpass-prod_edge alpine:3 \
  sh -c 'nc -zvw2 db 5432 || echo blocked'                  # blocked
docker run --rm --network pelicanpass-prod_edge alpine:3 \
  sh -c 'nc -zvw2 cache 6379 || echo blocked'               # blocked

# 4. The app can
docker compose exec app sh -c 'nc -zvw2 db 5432 && nc -zvw2 cache 6379'

# 5. Egress survives — TurnstileValidator calls challenges.cloudflare.com
docker compose exec app node -e \
  "fetch('https://challenges.cloudflare.com').then(r=>console.log('egress',r.status))"

# 6. The database holds none of the app's secrets
docker compose exec db env | grep -cE '^(TUNNEL_TOKEN|TURNSTILE_SECRET|REDIS_PASSWORD)='   # 0

# 7. Health endpoint
docker compose exec app node -e \
  "fetch('http://localhost:3000/healthz').then(r=>r.text()).then(console.log)"

# 8. The app's database role is not a superuser — every one of these must be denied
docker compose exec -T db sh -c 'psql -U "$APP_ROLE" -d "$POSTGRES_DB"' <<'SQL'
COPY (SELECT 1) TO PROGRAM 'id';          -- superuser RCE, the finding
UPDATE attendees SET ticket_code = 'x';   -- attendee_phone is updatable by design (016)
DELETE FROM attendees;
SELECT * FROM attendees;
CREATE TABLE scratch (i int);
SQL

# 9. End to end through the public hostname. /healthz is the one path custom
#    rule 2 exempts; everything else is challenged for a client with no clearance.
#    Custom rule 1 blocks every non-BR address, so run this from a Brazilian one.
curl -s -o /dev/null -w '%{http_code}\n' https://$HOST/healthz          # 200
curl -sI https://$HOST/healthz | grep -i cf-mitigated                    # no output
curl -sI https://$HOST/checkin | grep -iE '^HTTP|cf-mitigated'          # 403, challenge

# 10. Security headers — script-src names only Cloudflare, 'self' and a nonce, no
#     CDN wildcard. Read at the origin: through the edge, curl only ever sees the
#     challenge page's own policy ('unsafe-eval', `form-action http: https:`).
docker compose exec -T app node -e "
fetch('http://127.0.0.1:3000/checkin').then((r) => { for (const h of
  ['content-security-policy', 'permissions-policy']) console.log(h + ':', r.headers.get(h)); });"

# 11. A forged client IP from inside the network is refused — expect 403, and
#     no matching request line in `docker compose logs app`. A 200 means the Host
#     matched no site: Caddy answers an unknown host with an empty 200.
docker compose exec -T app node -e "
const http = require('http');
http.request({host:'proxy',port:80,path:'/healthz',agent:false,
  headers:{'Host':'$HOST','CF-Connecting-IP':'203.0.113.9'}},
  r => { console.log('status', r.statusCode); r.resume(); }).end();"

# 12. A bad request body is a client error, not a 500. Expect 415 / 400 / 413,
#     all as JSON, and zero `error`-level lines in the app log afterwards. A POST
#     must name the app's own origin, so the probe sends one.
docker compose exec -T app node --input-type=module -e "
const o = new URL(process.env.APP_URL).origin;
const go = async (l, i) => { const r = await fetch('http://127.0.0.1:3000/api/v1/checkin/ticket', { ...i, headers: { Origin: o, ...i.headers } });
  console.log(l.padEnd(16), r.status, r.headers.get('content-type')); };
await go('text/plain', {method:'POST',headers:{'Content-Type':'text/plain'},body:'x'});
await go('bad json', {method:'POST',headers:{'Content-Type':'application/json'},body:'{not json'});
await go('oversized', {method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({ticket:'x'.repeat(11000)})});"

# 13. Per-IP quotas are sized for a venue behind one NAT address, not for one
#     person per address. Expect the first 429 at #61 and #301 respectively —
#     anything lower means the tiering regressed and the door will jam.
#     The /checkin half reads `none` while the landing curtain is up: the gate
#     answers before checkinEntryIpLimiter. The /api/v1 probe is a text/plain
#     POST, charged by ipLimiter and then refused 415 with no further work.
docker compose exec -T app node --input-type=module -e "
const hit = (p, xff, init = {}) => fetch('http://127.0.0.1:3000' + p,
  { ...init, headers: { 'X-Forwarded-For': xff, ...init.headers } }).then((r) => r.status);
const first = async (l, p, n, init) => { const a = '10.99.' + (Date.now() % 250) + '.7'; let f = null;
  for (let i = 1; i <= n; i++) { const s = await hit(p, a, init); if (s === 429 && f === null) f = i; }
  console.log(l.padEnd(30), 'first 429 at #' + (f ?? 'none')); };
await first('GET /checkin (60)', '/checkin', 65);
await first('/api/v1 (300)', '/api/v1/checkin/ticket', 305,
  { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });"

# 14. Containers cannot reach the host, the LAN or the tailnet, but can reach
#     the internet. Requires the egress filter from container-containment.md §4.
~/.local/bin/container-egress-filter.sh status          # six IPv4 rules on the uplink
systemctl --user is-active container-egress-filter.service

# 15. No session in Redis holds anything derived from a phone number. Run this
#     with a check-in part-way through, i.e. after the ticket step. Expect 0.
#     A non-zero count means a phone digest came back into the session; see
#     data-retention.md.
docker compose exec -T app node --input-type=module -e "
import redis from './src/shared/db/redis.ts';
await redis.connect();
const keys = (await redis.keys('session:checkin:*'));
const blobs = await Promise.all(keys.map((k) => redis.get(k)));
console.log('sessions', keys.length, 'with a phone digest',
  blobs.filter((b) => /phoneHash|phoneLast4Hash/.test(b ?? '')).length);
await redis.quit();"

# 16. Degraded mode: with Redis gone the app fails fast and keeps enforcing
#     limits in-process. Do this BEFORE the event, never during it.
#     Expect ~0.1s and a 503 - not a hang. On the stock ioredis defaults this
#     did not respond within 60s, because the retry cost compounds across the
#     ~8 Redis calls the entry path makes. Timed at the origin so an edge
#     challenge cannot stand in for the app's answer. While the landing curtain
#     is up, /checkin answers 200 from the gate without reaching that path, so
#     run it with LANDING_ENABLED=false to see the 503 and its Retry-After: 5.
docker compose stop cache
docker compose exec -T app node --input-type=module -e "
for (const p of ['/checkin', '/healthz']) { const t = performance.now();
  const r = await fetch('http://127.0.0.1:3000' + p, { signal: AbortSignal.timeout(30000) });
  console.log(p.padEnd(10), r.status, 'in', ((performance.now() - t) / 1000).toFixed(3) + 's'); }"

#     Limits still bite from the memory tier - expect the first 429 at #301,
#     the same threshold Redis enforces, because this runs a single process.
docker compose exec -T app node --input-type=module -e "
const hit = (x) => fetch('http://127.0.0.1:3000/api/v1/checkin/ticket', { method: 'POST',
  headers: { 'X-Forwarded-For': x, 'Content-Type': 'text/plain' }, body: 'x' }).then((r) => r.status);
const a = '10.99.' + (Date.now() % 250) + '.7'; let f = null;
for (let i = 1; i <= 320; i++) { const s = await hit(a); if (s === 429 && f === null) f = i; }
console.log('first 429 at #' + (f ?? 'none'));"

docker compose start cache          # recovers on its own, no app restart
docker compose logs app --tail 5 | grep 'Redis ready'
docker inspect -f '{{.RestartCount}}' pelicanpass-app      # 0
```

Then run all six checks in §6 of [`container-containment.md`](../infrastructure/container-containment.md) — they cover
the same ground in more depth, including the one that proves cloudflared cannot reach the database.

Then check the real thing, because reachability is not the same as working:

- [ ] Complete a full check-in in a browser: ticket → verification → QR → pass. This is the
      **grant-completeness test** — a column the app reads but was never granted surfaces as a 500
      here and nowhere earlier.
- [ ] Confirm the Turnstile widget renders and validates.
- [ ] Open `/checkin` with the browser console open: **zero CSP violations**. Web fonts, the
      Material Symbols icons and the Turnstile frame all rendering is what proves `style-src`,
      `font-src` and `frame-src` are not over-tightened. The QR scanner is bundled and served from
      this origin, so it cannot be verified by network access to a CDN — only by starting the
      camera.
- [ ] Scan a printed ticket QR with a phone, through an in-app browser (WhatsApp/Instagram), and
      confirm the entry link resolves.
- [ ] `docker compose ps` shows `app` as `healthy` once the 20s start period elapses.
- [ ] From a phone on mobile data, load `/checkin` and compare the logged `ip` against what
      `https://cloudflare.com/cdn-cgi/trace` reports on that same phone. They must be **equal** —
      every IP-keyed limit depends on it. `xff` must hold exactly one address; two means
      `trust proxy: 1` is consuming the wrong hop and every limiter is keyed on Caddy instead.
- [ ] Confirm the Cloudflare rules in [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) match the
      dashboard, that `/healthz` is untouched by all of them, and that `/css`, `/js` and
      `/assets` load once the challenge is cleared.

Then the observability stack, which has its own failure modes and mostly cannot be checked
from the outside:

- [ ] `/readyz` answers **403** through `<host>` and **200** through the tailnet name.
      It names which dependency is down and how long it took to say so, which is a
      reconnaissance gift through the tunnel and the reason it is gated at all.
- [ ] **Nothing restarts on `/readyz`.** Stop `cache`, confirm `/healthz` still answers 200,
      `/readyz` answers 503, a critical alert arrives inside 60 s — and `docker inspect`
      reports **RestartCount 0**. A readiness probe wired to `HEALTHCHECK` would restart the
      container mid-event over a blip, which is worse than the blip.
- [ ] A `warn` line reaches `/var/log/pelicanpass` **within a second**, not at process exit.
- [ ] That file survives `docker compose -f compose.prod.yml up -d --force-recreate app`.
      This is the whole point of the volume: container logs die with the container, and
      `deployment.md` used to record that as the only trace of a hand-marked arrival.
- [ ] `docker stats --no-stream` and `free -h`, recorded. The Postgres tuning promises the
      planner ~6 GB of page cache; that promise is worth one command.
- [ ] Container json-file logs cap at 50 MB per service (`max-size: 10m`, `max-file: 5`), and the
      app's at 200 MB (`max-file: 20`), which the teardown's traffic summary reads.
- [ ] `ALERT_ENABLED=true`, and a real message arrives in Discord. The dispatcher can be
      fully correct and still deliver nothing — the switch and the webhook are separate
      failures. The smoke script in [step 2](#2-clone-and-configure) is the test.

### Rehearsal — the attendee pass

Run this **before** the doors, not on the day: a failure here is a code change,
not a config tweak. It covers checks 22, 23 and 26 of the
[security checklist](../security/security-overview.md#before-every-event-security-checks) (the local headings
#13, #14 and #15 below), and nothing in it can
be done from a terminal — the whole point is that a person holds a phone.

You need two phones and a volunteer who is not you.

#### Setup

Two attendees, as `pelicanpass_migrator` — the volunteer needs `can_redeem`, which
`pelicanpass_app` deliberately cannot set. See
[`db-cheatsheet.md`](./db-cheatsheet.md) for the permission recipe and the
read-back that shows who currently holds it.

If the same volunteer is also running the raffle, they need `can_draw` — a
separate flag on the same terms, because calling numbers from a stage and
working a redemption counter are different jobs. Without it `/raffle` redirects
to their own pass and the surface does not exist for them, which is the failure
to discover here rather than on the night.

`redeem_scopes` defaults to every item, so a volunteer set up this way
hands over everything and stations are opt-in. If the event runs a t-shirt table
and a food table separately, narrow them with the recipe in the same file — and
rehearse it, because an out-of-scope item is refused by the server, not just
greyed out on the screen.

```sql
-- The pair: the seed's first participant and volunteer (db-cheatsheet.md).
-- The seed checks st3s00 in, so apply the reset below before the first run.
UPDATE attendees
SET tshirt_size = 'M - Preto', meal_option = 'Opção vegetariana',
    can_redeem = true, can_draw = true
WHERE ticket_code = 'vt3s00';

UPDATE attendees
SET tshirt_size = 'G - Roxo', meal_option = 'Opção vegetariana'
WHERE ticket_code = 'st3s00';
```

**The reset.** A rehearsal gets run more than once, and the second attempt
otherwise starts from a t-shirt already collected. The `DELETE` also removes any
correction an administrator made on the redemptions screen during the
rehearsal — those are audit rows like the counter's own:

```sql
UPDATE attendees
SET checkin_complete = false, checkin_at = NULL, checkin_number = NULL,
    tshirt_redeemed_at = NULL, meal_redeemed_at = NULL, drink_redeemed_at = NULL,
    lunch_redeemed_at = NULL, tshirt_volunteer_redeemed_at = NULL
WHERE ticket_code IN ('st3s00', 'vt3s00');

DELETE FROM redemptions
WHERE attendee_id IN (
  SELECT attendee_id FROM attendees WHERE ticket_code IN ('st3s00', 'vt3s00')
);
```

#### #13 — CSP and icons

Open `/pass` and then `/staff` with the browser console visible. **Turn the
pass over as well** — the QR is on its back face, and a face that has never been
shown has painted nothing to violate a policy or fail a glyph.

- [ ] **Zero CSP violations** on both. The QR on the pass is a `data:` URI, which
      Helmet's default `img-src 'self' data:` admits; a violation here means that
      default was narrowed somewhere.
- [ ] **No icon renders as its literal ligature text** — the word
      `qr_code_scanner` in place of a glyph. The font subset is frozen at 18
      glyphs and a nineteenth fails **silently, with no console error**, so this
      one can only be caught by looking. Both faces of the pass carry one:
      `qr_code_scanner` under the chips, `close` on the back.

#### #14 — the backgrounded band

> Checks #14 and #15's band steps assume `PASS_BAND_ENABLED=true`, which is the
> default. With it off there is no band on either screen and no `/staff/band`
> poll behind it: both show only a clock, and what #14 tests instead is that the
> pass's **QR** refreshes on return. Everything else in #15 stands unchanged —
> the token, the review and the redemption are independent of it.

**Turn the pass over first.** The QR lives on the back, and nothing polls while
the front is showing — run this on the front and it proves nothing.

- [ ] Open a pass and tap a chip to turn it over. Lock the phone. Wait two
      minutes. Unlock.
- [ ] Repeat with the browser merely backgrounded rather than the screen locked —
      that throttles timers rather than suspending them, and it is a different
      code path through the same handler.

The band must **refresh on return**, or grey itself and ask for a page reload.

> **What a failure looks like:** not a blank band — a band that reads crisply and
> is *wrong*. That is worse than a greyed one, because nothing on screen tells
> the volunteer to distrust it, and they will refuse a legitimate attendee.

#### #15 — two phones, end to end

- [ ] Volunteer B opens `/staff`. Their band matches the word on A's pass, and
      both flip within about a second of each other.
- [ ] B scans A's QR. The review shows A's identifier — a `#number` for a
      participant, a **first name** for a volunteer, who has no number.
- [ ] B **slides** the t-shirt row across, sees the t-shirt reported
      **redeemed**, and the row reads as redeemed. A tap does nothing on purpose — the row is
      dragged past about two thirds and released, and the fill deepens at the
      point where letting go commits. Worth doing once badly on purpose:
      released short of that, it snaps back and records nothing.
- [ ] **A's pass, still turned to its QR, picks the redemption up on its own
      within one window.** Turning it back to the front then shows it redeemed
      without a reload — the turn itself fetches once more, so a redemption
      recorded while A was putting their phone away is not missed.
- [ ] B scans A again → the t-shirt row reads **redeemed** and has no
      thumb to slide, shown as an answer rather than an error.
- [ ] An item A has no entitlement to reads **unavailable** and has no
      thumb to slide.

#### The acceptance test

This is the thing the whole design was asked for, so it is worth running on its
own rather than as a step inside #15.

- [ ] Screenshot a live pass **on its QR side**. Wait 60 seconds. Hold the
      screenshot beside the live pass: **the band differs and the clock is
      frozen**.
- [ ] Scan the screenshot's QR at `/staff` → **rejected as expired**.

> If the band still matches after 60 seconds, the derivation is wrong. If the
> screenshot's QR is *accepted*, **stop and do not open the doors** — that is
> precisely the failure this feature exists to prevent.

#### `/staff` through the edge

Neither admin gate matches `/staff` — the Access application's destinations are
`<host>/admin` and `<host>/api/v1/admin`, and the origin mounts
`requireAccessAssertion` on those two prefixes only — so this is a
confirmation rather than a discovery.

- [ ] Load `/staff` at the **public hostname**, not just the origin. A 403 from
      the edge and a 403 from the application are indistinguishable from a phone,
      so only the public path proves it.

#### Two things to tell the floor

**A Redis outage is invisible to every health signal.** `/healthz`
(`src/app.ts:128-130`) answers `{"status":"ok"}` without touching Redis or
Postgres, so the container stays `healthy` and Caddy keeps routing while every
attendee-facing page and check-in call answers `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`
([`rate-limiting.md` § Redis outage](../performance/rate-limiting.md#redis-outage)). The admin surface is unaffected.

> **A wave of 503s with `Retry-After: 5` across every attendee surface at once means the
> `cache` container, not the pass work.** Do not roll this feature back for it. Reconnection is
> automatic once Redis returns; no application restart is needed.

> The band's refresh button sends the page to `/checkin?error=UNAUTHORIZED`
> when it meets a 401, so anyone tapping it during an outage lands on check-in
> with the session-expired message on screen rather than on a surface that keeps
> refusing. Expect it to be reported as the pass "logging people out" anyway;
> it is the session already being gone, not the pass losing it.

**One scan per attendee per 30-second window.** A pass token is deterministic
within its window, so scanning the same person twice before the band rotates is
refused as a replay. That is correct, and it will look like a bug to a
volunteer. The review handle lives two minutes — keep it and tap again rather
than asking for the phone a second time.

> The ring around the band is how long is left of that window, on both screens
> at once. If a re-scan has to happen, it is the wait.

### Rehearsal — the questionnaire

Run this on staging **before the event's image is built**: step 25 redacts every attendee, and
steps 16–24 edit the questions files. Its steps keep the numbering of the retired build checklist's
phase 7.

You need a participant phone, a volunteer phone, an administrator holding **both** `export:read` and
`survey:write` (grant them with `scripts/admin/set-admin-scopes.ts`), and a shell on the staging
host. Each step is marked **Phone** (a person, a screen) or **Terminal** (the helpers below).

#### Setup

In `.env`, then `docker compose up -d --force-recreate app`:

```bash
SURVEY_PARTICIPANT_ENABLED=true
SURVEY_VOLUNTEER_ENABLED=false
SURVEY_OPENS_AT=<a few minutes from now, with its offset>
SURVEY_CLOSES_AT=<later today, inside ATTENDEE_SESSION_TTL of the volunteer door>
```

Check in three participants and one volunteer on real phones — the pass rehearsal's test tickets
and their reset above serve. Check in three **other** participants and another volunteer for the
terminal, on any phone. Production keeps one session per attendee, so minting a session below logs
out the phone holding that ticket, and checking that ticket in again ends the minted one: never
mint a ticket a phone step still uses.

The terminal steps need an attendee's session, and a phone's cannot be copied off it. So the
helpers below **mint real sessions** in the app container, bound to the user agent `rehearsal`
(a session is checked against a hash of the agent it was issued to), and send every request to the
origin at `127.0.0.1:3000`, where the edge's challenge never sees it — the same route the
verification checks above take. A minted session is a real one for its whole TTL: this is a
staging-only tool. Paste the block once into the staging shell (bash or zsh):

```bash
# Runs a snippet in the app container at the origin, quietly. Snippets are
# double-quoted, so they must not contain `!`: an interactive shell expands it
# from history before the function is even defined.
appnode() { docker compose exec -T -e LOG_LEVEL=silent app node --input-type=module -e "$@"; }

# mint TICKET — a real attendee session for that ticket, bound to the
# `rehearsal` user agent. Prints the cookie.
mint() { appnode "
const { initRedis, default: redis } = await import('./src/shared/db/redis.ts');
initRedis();
if (redis.status === 'wait') await redis.connect();
const { default: pg } = await import('./src/shared/db/postgres.ts');
const { env } = await import('./src/config/env.ts');
const { sessionService } = await import('./src/modules/session/session.service.ts');
const { hashUA } = await import('./src/shared/utils/hash.ts');
const { rows: [a] } = await pg.query(
  'SELECT attendee_id, attendee_role FROM attendees WHERE ticket_code = \$1 AND event_id = \$2',
  [process.argv[1], env.eventId]);
if (a === undefined) { console.error('no attendee holds that ticket'); process.exit(1); }
const { sessionId } = await sessionService.create('attendee', { type: 'attendee', version: 1,
  attendeeId: a.attendee_id, attendeeRole: a.attendee_role, ua: hashUA('rehearsal') });
console.log('attendee_session_id=' + sessionId);
process.exit(0);" "$1"; }

# api METHOD PATH [COOKIE] [JSON] — one request at the origin. Prints the
# status and the start of the body.
api() { appnode "
const [method, path, cookie, body] = process.argv.slice(1);
const r = await fetch('http://127.0.0.1:3000' + path, { method, redirect: 'manual',
  headers: { 'user-agent': 'rehearsal', origin: new URL(process.env.APP_URL).origin,
    ...(cookie ? { cookie } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body || undefined });
console.log(r.status, (await r.text()).slice(0, 200));" "$@"; }

# body AUDIENCE [OVERRIDES] — a valid submission against the deployed
# questions, with OVERRIDES (JSON) merged over its answers.
body() { appnode "
const { surveyFor } = await import('./src/modules/survey/survey.definition.ts');
const d = surveyFor(process.argv[1]);
const answers = Object.fromEntries(d.questions.filter((q) => q.required).map((q) =>
  [q.id, q.type === 'rating' ? 8 : q.type === 'yes-no' ? true : 'ok']));
console.log(JSON.stringify({ structureVersion: d.structureVersion,
  answers: { ...answers, ...JSON.parse(process.argv[2] || '{}') } }));" "$1" "${2:-}"; }

# session ttl|del COOKIE — the Redis TTL of a minted session, or delete it.
session() { appnode "
const { initRedis, default: redis } = await import('./src/shared/db/redis.ts');
initRedis();
if (redis.status === 'wait') await redis.connect();
const { hash } = await import('./src/shared/utils/hash.ts');
const key = 'session:attendee:' + hash(process.argv[2].split('=')[1]);
console.log(process.argv[1] === 'del' ? await redis.del(key) : await redis.ttl(key));
process.exit(0);" "$1" "$2"; }

# phone-ttl TICKET — seconds left on the newest session a real phone holds
# for that ticket. Production only: the pointer is not kept in development.
phone_ttl() { appnode "
const { initRedis, default: redis } = await import('./src/shared/db/redis.ts');
initRedis();
if (redis.status === 'wait') await redis.connect();
const { default: pg } = await import('./src/shared/db/postgres.ts');
const { env } = await import('./src/config/env.ts');
const { hash } = await import('./src/shared/utils/hash.ts');
const { rows: [a] } = await pg.query(
  'SELECT attendee_id FROM attendees WHERE ticket_code = \$1 AND event_id = \$2', [process.argv[1], env.eventId]);
const digest = a && await redis.get('session:attendee:current:' + hash(a.attendee_id));
console.log(digest ? await redis.ttl('session:attendee:' + digest) : 'no current session');
process.exit(0);" "$1"; }

# pass COOKIE — the questionnaire's state as the pass poll reports it.
pass() { appnode "
const r = await fetch('http://127.0.0.1:3000/api/v1/attendee/pass',
  { headers: { 'user-agent': 'rehearsal', cookie: process.argv[1] } });
const j = await r.json();
console.log(r.status, JSON.stringify(j.data?.survey ?? j.code));" "$1"; }

# twice COOKIE JSON — two submits in flight at once from one session.
twice() { appnode "
const [cookie, body] = process.argv.slice(1);
const go = () => fetch('http://127.0.0.1:3000/api/v1/survey', { method: 'POST', body,
  headers: { 'user-agent': 'rehearsal', origin: new URL(process.env.APP_URL).origin,
    cookie, 'content-type': 'application/json' } })
  .then(async (r) => r.status + ' ' + (await r.json()).code);
console.log((await Promise.all([go(), go()])).join(' | '));" "$1" "$2"; }

# burst COOKIE_A COOKIE_B — exhausts the per-address tier from one address,
# then submits twice from that same address. Neither submit may be RATE_LIMITED.
burst() { appnode "
const [a, b] = process.argv.slice(1);
const xff = '10.98.' + (Date.now() % 250) + '.7';
const post = (path, init) => fetch('http://127.0.0.1:3000' + path,
  { method: 'POST', ...init, headers: { 'user-agent': 'rehearsal', 'X-Forwarded-For': xff,
    origin: new URL(process.env.APP_URL).origin, ...init.headers } });
let limited = 0;
for (let i = 0; i < 320; i++) {
  const r = await post('/api/v1/checkin/ticket', { headers: { 'content-type': 'text/plain' }, body: 'x' });
  if (r.status === 429) limited++;
}
console.log('other traffic refused with 429:', limited);
const { surveyFor } = await import('./src/modules/survey/survey.definition.ts');
const d = surveyFor('participant');
const answers = Object.fromEntries(d.questions.filter((q) => q.required).map((q) =>
  [q.id, q.type === 'rating' ? 8 : q.type === 'yes-no' ? true : 'ok']));
for (const cookie of [a, b]) {
  const r = await post('/api/v1/survey', { headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ structureVersion: d.structureVersion, answers }) });
  console.log('submit:', r.status, (await r.json()).code);
}" "$1" "$2"; }
```

`body participant '{"overall_rating": 11}'` builds a valid submission from whatever questions are
deployed and merges the override over its answers, so these commands survive the real questions
replacing the placeholders.

#### The steps

```bash
# The terminal's tickets, none of them held by a phone.
P1=$(mint <participant ticket 1>); P2=$(mint <ticket 2>); P3=$(mint <ticket 3>)
V1=$(mint <volunteer ticket>)
```

1. **Terminal**, before the open time: `api POST /api/v1/survey "$P1" "$(body participant)"` is
   `403 SURVEY_CLOSED`, and `pass "$P1"` reports `open: false`. **Phone:** no chip on the pass.
2. **Phone.** On `/admin/survey` set the override to **force open**. On a pass already open, the
   survey chip appears after the pass is turned to its back or the page reloads, and not before.
3. **Phone.** Answer and send: the dialog shows the thanks and the chip goes. Reload: no chip.
4. **Terminal.** `twice "$P2" "$(body participant)"` prints one `201 SURVEY_RECORDED` and one
   `409 SURVEY_ANSWERED`. The response count on `/admin/survey` rises by exactly one.
5. **Terminal.** Each is `400 VALIDATION_ERROR` except the last:
   ```bash
   api POST /api/v1/survey "$P3" "$(body participant '{"overall_rating": 11}')"
   api POST /api/v1/survey "$P3" "$(body participant '{"not_a_question": 1}')"
   api POST /api/v1/survey "$P3" "$(body participant '{"overall_rating": null}')"  # a required one left blank
   api POST /api/v1/survey "$P3" '{"structureVersion":"x","answers":{}}'     # 409 SURVEY_STALE
   ```
   Replace `overall_rating` with an id from the deployed file if the real questions have gone in.
6. **Terminal.** `pass "$V1"` reports `open: false`; `api POST /api/v1/survey "$V1" "$(body
   participant)"` is `403 FORBIDDEN`; `/admin/survey` shows the volunteer switch off. Then set
   `SURVEY_VOLUNTEER_ENABLED=true`, move `src/web/content/pt-BR/survey-volunteer.md` aside and
   recreate: `docker compose logs app` names the missing file and the app does not start. Put the
   file back, set the switch off, recreate.
7. **Terminal.** `api POST /api/v1/survey '' "$(body participant)"` is `401`. `session del "$P3"`
   prints `1`; then `api POST /api/v1/survey "$P3" "$(body participant)"` is `401` too.
   **Phone:** `/pass` in a private tab redirects to `/checkin`. Mint `P3` again afterwards.
8. **Phone.** The attendee from step 3 checks in again on a second phone: no chip. **Terminal:**
   `api POST /api/v1/survey "$(mint <that ticket>)" "$(body participant)"` is
   `409 SURVEY_ANSWERED`, and the count on `/admin/survey` has not moved.
9. **Phone** (admin): archive participant 3 in the attendees editor. **Terminal:** their submit is
   `404 NOT_FOUND` and the count has not moved. Unarchive them.
10. **Terminal.** `phone_ttl <ticket>` for an attendee who checked in when their door opened is at
    least the seconds from now until `SURVEY_CLOSES_AT`. Boot enforces the configuration; this reads
    the live key.
11. **Phone.** Set the override to **force closed**: the chip is gone on the next turn of the pass,
    and step 1's submit is `SURVEY_CLOSED`. Set it to **automatic**: the schedule governs again.
12. **Terminal.** Set an override, `docker compose up -d --force-recreate app`, reload
    `/admin/survey`: the override is still selected.
13. **Phone.** Answer a text question with `=HYPERLINK("http://example.com")`. Download the
    participant CSV from `/admin/survey`, and **Terminal:**
    `docker compose run --rm -T migrate node scripts/survey/export-csv.ts --audience participant > p.csv`.
    Both cells read `'=HYPERLINK(...)`; `cmp` the two files — identical. Open both in LibreOffice:
    the cell is text, not a link.
14. **Terminal.** As the migrator, `\d survey_responses` has no attendee column and no timestamp,
    and `\d survey_completions` no answers column. As the read-only role, `SELECT xmin FROM
    survey_responses` and the same on `survey_completions` are denied.
15. **Terminal.** `docker compose logs app | grep -c HYPERLINK` is `0`, and so is the same text
    searched in `app_events.message` and `app_events.context`.
16. **Terminal.** Edit a label in `survey-participant.md` and redeploy. A pass left open from before
    still submits (`201`). The participant CSV now carries two `survey_version` values.
17. **Phone.** Add a question and redeploy. A pass left open from before gets the stale answer on
    submit, reloads, and shows the new question.
18. **Terminal.** Remove a question that already has answers and redeploy. Its answers are in
    `other_answers` in both the download and `export-csv.ts`.
19. **Terminal.** `burst "$P2" "$P3"` sends 320 requests from one address, then submits twice from
    it: some of the other traffic is refused with `429`, and neither submit is `RATE_LIMITED`
    (`201`, or `409 SURVEY_ANSWERED` for one that already answered).
20. **Phone.** Set `SURVEY_VOLUNTEER_ENABLED=true`, with `survey-volunteer.md` holding questions
    different from the participant file, and redeploy. The volunteer pass shows the chip, the
    volunteer questions and the volunteer anonymity line. Steps 3, 4, 5 and 8 pass for a volunteer,
    using `body volunteer`.
21. **Terminal.** `/admin/survey` shows a count and a download per audience. Each CSV carries only
    its own audience's columns, their `survey_version` values differ, and each `cmp`s identical to
    `export-csv.ts --audience <audience>`.
22. **Terminal.** Edit a label in `survey-volunteer.md` and redeploy: a participant pass and a
    volunteer pass left open from before both still submit.
23. **Phone** (admin): make a participant who has not answered a volunteer while their dialog is
    open. Their send is refused as stale, the reload shows the volunteer form, and sending it adds
    to the volunteer count.
24. **Terminal.** `SURVEY_VOLUNTEER_ENABLED=false`, redeploy: `pass "$V1"` is `open: false`, a
    volunteer submit is `403 FORBIDDEN`, and the volunteer download is still offered with its
    columns. Then remove `survey-volunteer.md` and redeploy: the download is still offered, and its
    answers are all in `other_answers`.
25. **Terminal, last.** Run `scripts/db/purge-attendees.sql` (teardown step 0) while the schedule
    says open: it reports `completions_remaining = 0` and `survey_override = closed`,
    `/admin/survey` reads closed by override, and a submit from a minted session is
    `SURVEY_CLOSED`.

#### Reset (step 26)

Revert the edits to both questions files, set the switches back, and as the migrator:

```sql
TRUNCATE survey_responses, survey_completions, survey_state;
```

`survey_state` is in the list on purpose: without it step 25's closed override carries over into
the next run, and into the event if this is the last one. Step 25 also redacted **every** staging
attendee's name and phone — re-import the roster before another run, then apply the pass
rehearsal's reset above.

### Rehearsal — check-in, the admin screens and the floor

Run this on the **production host, on the release image**, after the verification checks and
before the doors. The pass rehearsal above starts from an attendee who has already checked in;
this one covers getting there, every administrator screen used on the night, the raffle, the
WhatsApp templates and the door's manual path. A failure in it is a code change, and a code change
means a new image and this rehearsal again.

You need the pass rehearsal's two test tickets, an iPhone and an Android phone, a volunteer who is
not you, and three administrator accounts made for the rehearsal and disabled afterwards:

```bash
docker compose run --rm migrate node scripts/admin/create-admin.ts --username rehearsal-desk \
  --scopes attendees:read,attendees:write,checkin:write,redemptions:read,redemptions:write,volunteers:write,whatsapp:send,metrics:read,pass:write
docker compose run --rm migrate node scripts/admin/create-admin.ts --username rehearsal-lookup \
  --scopes attendees:read
docker compose run --rm migrate node scripts/admin/create-admin.ts --username rehearsal-tshirt \
  --scopes tshirt:redeem
```

Two printouts as well: the poster URLs from `docker compose exec app node scripts/qr/urls.ts`,
printed at the real size, and `st3s00`'s entry link built from the `ticket_link_token` query in
[`db-cheatsheet.md`](./db-cheatsheet.md).

#### Check-in — three ways in, three browsers

Run every entry on **iOS Safari** and **Android Chrome**, and the entry link in the **WhatsApp
in-app browser** on both phones as well: it is the one most attendees will use, and the only run
that opens the scanner inside it. Apply the pass rehearsal's reset between runs. Every run ends on
the pass, and neither the camera nor Turnstile may stall it.

- [ ] **Bare `/checkin`.** Type `st3s00`: the screen says the ticket was found. Type the last
      four digits of its phone: it says the identity is confirmed. Allow the camera and scan the
      printed poster: it says the presence is confirmed. The success card shows the first name and
      a check-in number, then moves to the pass on its own.
- [ ] **The entry link, sent to the phone in WhatsApp and tapped there.** Either the check-in
      page opens with the code already accepted, or a **continue to check-in** page opens first
      (the link was treated as coming from another site) and its **continue** button leads to the
      same place. The address bar must not still hold `?t=`. Then the four digits and the
      poster scan, as above.
- [ ] **The poster, scanned with the phone's own camera app.** The check-in page opens with the
      arrival step already done. The code and four digits are the only steps left, and no
      scanner opens.
- [ ] **The volunteer poster with `vt3s00`.** The code field starts with six cells and keeps
      them while the code can still be a volunteer's. The pass shows the volunteer header, and
      the access tab once the station flags from the pass rehearsal are set.
- [ ] **The refusals.** An unknown code and a wrong four digits read as an invalid code and an
      invalid phone, the same wording as a badly formed entry. Keep going until the server asks
      for human verification: the flow returns to the start with a too-many-attempts message
      asking to restart the check-in and complete the verification, a Turnstile widget
      appears and can be solved on a phone, and a correct entry afterwards completes the
      check-in.
- [ ] **Camera refused.** Deny the camera permission on the arrival step. The screen still shows
      the hint to call a volunteer if it does not work. Then handle it the way the door will:
      the [manual path](#the-door-manual-path) below.
- [ ] **Already checked in.** Open `/checkin` again on the same phone: it lands on the pass. On a
      second phone, the code and four digits are enough, with no scanner and the same check-in
      number.
- [ ] **The curtain**, if `LANDING_ENABLED=true`. Before the window `/checkin` shows the
      countdown and the open time from [On the day](#on-the-day-at-the-venue). When the
      countdown ends the page moves to check-in by itself within 90 seconds, with no reload.

#### The admin screens, through the edge

Sign in at the **public hostname** on a phone, through Cloudflare Access with the phone owner's
address on the policy, then once more over the tailnet on `ADMIN_URL`. Every screen below is opened once
from each route.

- [ ] **Sign-in.** The Access code arrives, the app's own form follows, its Turnstile solves, and
      **sign in** lands on `/admin` with only the sections the account holds a scope for. A wrong
      password is refused.
- [ ] **Attendees.** **New attendee** with the ticket code left blank: **save** reports the
      changes saved, and the code is issued as `dXXXXX`. Edit its t-shirt and meal from the
      dropdowns, save, and reload: the values stay. **Archive** → its confirmation → the attendee
      is reported archived, and the walk-in's entry link now refuses at `/checkin`. **Restore**
      brings it back.
- [ ] **The door message**, if `WHATSAPP_DOOR_ENABLED=true`. With the roster switch on, saving the
      walk-in with a phone you hold reports the changes saved and the pass sent by WhatsApp,
      and the message arrives with a button that opens `/checkin`. With the switch off, the save
      says the link was not sent.
- [ ] **Lookup, as `rehearsal-lookup`.** Search `st3s00` by name: the record shows the code and
      arrival, the verification code is hidden behind its control, and there is **no** confirm
      button. Grant `checkin:write` with `set-admin-scopes.ts` and reload without signing out:
      the **confirm check-in** button (for when the QR cannot be scanned) → its confirmation →
      the check-in is reported confirmed. Pressing it a second time returns the same number.
- [ ] **Redemptions.** After the pass rehearsal's redemption, `st3s00`'s record shows the t-shirt
      in its history. **Cancel redemption** on it refuses until a reason is chosen, then reports
      the redemption cancelled, and the pass shows the t-shirt available again. **Mark as
      redeemed** on the meal reports the redemption recorded, and the per-item status totals
      follow both. Leave the t-shirt cancelled for the next step.
- [ ] **T-shirts, as `rehearsal-tshirt`.** The account sees this section only. Search by phone
      digits, open `st3s00`, open the verification code, then **hand over the <size> t-shirt** →
      its confirmation → the handover is reported recorded. A second attempt reports the t-shirt
      already handed over, and `/admin/redemptions` counts the handover.
- [ ] **Volunteers.** On `vt3s00`, clear and then set the stations and the number generator
      permission. **Save** reports the permissions saved, a second save with nothing changed
      reports that nothing changed, and the history records both changes. The volunteer's open
      pass changes its tab on its next poll.
- [ ] **Pass welcome line.** The schedule in force matches `PASS_WELCOME_SCHEDULE`. Saving an
      edit changes the line on an open pass by its next poll, and confirming the **revert to the
      server configuration** control hands it back to `.env`.
- [ ] **Status.** `/admin/metrics` loads with every panel filled. The check-ins and redemptions
      from this rehearsal show in the check-ins and redemptions panels, and the browser console
      shows no errors.

#### The raffle

- [ ] `vt3s00` with `can_draw` opens `/raffle` from the pass tab. The draw button calls a
      checked-in number. With the **allow repeats** toggle off, keep drawing until the screen
      says every number has been drawn. A drawn number's **put back** control returns it to the
      pool and the counters follow.
- [ ] Clear `can_draw` on `/admin/volunteers`: the next `/raffle` load redirects to the pass.
- [ ] Present it on the stage screen it will be shown on, at the distance it will be read from.

#### The ticket limit

A cap on how many participant tickets the attendees editor can issue, set from the roster panel
with no restart. It counts either every participant ticket (**total**) or only the codes the
editor generated, `d*` (**door**); archived attendees and volunteers never count. Once the cap is
reached **hard** refuses a new or restored participant with a message that the limit was reached,
and **warn** lets it through with a warning toast and a `TICKET_LIMIT_EXCEEDED` warning in
`app_events`. Archiving is never refused, and neither is restoring someone already active. Imports
are never refused but count, so a roster load can leave a total limit over its cap. Lowering the
cap below usage is allowed. Everyone who can open the roster (`attendees:read`) sees the panel while
the limit is on, read-only; with it off only `attendees:limit` holders see it, to switch it on, and
only they get the Edit button. The panel reads `ok` below 90%, `near` from 90%, `reached` at the cap
and `over` above it.

**Give `attendees:limit` to the supervisor, not to door staff.** The people who hold
`attendees:write` are the ones the limit constrains; if they could also move the cap, it would
stop them in name only. They still see the status on the roster and the remaining count in a
banner on the attendee form. The scope needs `attendees:read` beside it to reach the roster. See
[`admin-scopes.md`](../features/admin-scopes.md#attendeeslimit).

**Known gap in door scope.** A walk-in saved with a code typed by hand is counted only if it
starts `d`. A code with any other key, such as `xabc12`, is neither
counted nor blocked. The panel says so in a hint. Use total scope when typed codes are in play.

- [ ] **Set it, as an account holding `attendees:read,attendees:limit`.** Grant the scope to
      `rehearsal-desk` with `set-admin-scopes.ts` and reload. On `/admin/attendees`, **Edit** the
      limit panel: door scope, a cap one above the current usage, hard. **Save** redraws the panel
      with the new figures, with no restart.
- [ ] **Hard.** **New attendee** with the code blank, as a participant: it saves, the form's
      banner and the panel show the cap reached, and the next **New attendee** is refused with the
      limit message. **Archive** one: the next save goes through. Restoring it is refused while the
      cap is full.
- [ ] **Warn.** Switch the mode to warn: the save goes through, one warning toast carries the
      confirmation and the limit message, and the panel reads over. `app_events` holds `TICKET_LIMIT_SET` and
      `TICKET_LIMIT_EXCEEDED` rows.
- [ ] **A volunteer** saves at any usage in either mode.
- [ ] **Read-only.** As an account holding `attendees:read` only: the roster shows the limit status
      with no **Edit** button, and no panel at all while the limit is off.

#### WhatsApp

The template list changed in this release. For **each** template the event will send, to a phone
you hold:

- [ ] `docker compose exec app node scripts/whatsapp/send-test.ts --ticket st3s00 --template <key>`,
      with each key from `src/constants/whatsapp-templates.ts` in turn. Without `--template` it
      builds the default test template, not the event's. Read the body against the approved
      template in WhatsApp Manager: the variable count and `pt_BR`. Use `--ticket vt3s00` for a
      volunteer template.
- [ ] Repeat with `--send`. The message arrives, its fields hold the real values (`team`,
      `checkinTime` and `lunchOption` on a volunteer template), and its button opens `/checkin`
      with the code already accepted.
- [ ] On `/admin/whatsapp`: **preview** counts the audience the run will reach, and **send
      test** to your phone reports it sent. Start no run.

Then the checks in [`whatsapp-integration.md`](../features/whatsapp-integration.md#verifying-the-setup). The
webhook comes on only at the event: once it does, send one test and confirm the app logs
`WhatsApp receipts applied`, which proves the subscription, the edge and the app secret.

#### The door: manual path

For an attendee a challenge or a camera has stranded. Rehearse it with the people who will be at the
support desk, not with you.

- [ ] Every support desk device holds a working lookup account (`attendees:read,checkin:write`)
      whose email is on the Access policy, and at least one is enrolled on the tailnet.
- [ ] The camera-refused attendee from above: the desk finds them on `/admin/lookup`, checks the
      four digits, confirms the presence, and tells them to open `/checkin` and enter the code
      and four digits. The pass opens without the scanner.
- [ ] An attendee with no code at all: **new attendee** at the walk-in desk, then the same.
- [ ] The desk knows the cut-over in [`fallback.md`](./fallback.md#3-cut-over) is the operator's
      decision, not theirs, and who to call.

#### Reset

Apply the pass rehearsal's reset to both tickets, and as the migrator, before the doors only:

```sql
DELETE FROM raffle_draws WHERE event_id = '<EVENT_ID from .env>';
```

Archive the rehearsal's walk-ins rather than deleting them, set the ticket limit back to what the
event wants (or off, as in [`db-cheatsheet.md`](./db-cheatsheet.md)), set the `/admin/pass` schedule back to
`.env`, and disable the three rehearsal accounts with `set-admin-scopes.ts --disable`. Remove their
addresses from the Access policy, and any test device from the tailnet.

### On the day, at the venue

- [ ] **Confirm the check-in windows before anything else**, because the landing page is what every
      attendee sees until they open:

      ```bash
      docker compose exec app printenv LANDING_ENABLED EVENT_START_AT
      curl -s https://<your-host>/checkin | grep -o 'O check-in abre <strong>[^<]*'
      ```

      The page prints the absolute open time it computed. Read that line rather than the raw
      variable — it is the arithmetic and the timezone together, and it is what the attendee reads.
      Volunteers open four hours before `EVENT_START_AT`, participants thirty minutes before.

      To move a window, edit `.env` and recreate (see the `--force-recreate` note below). To take the
      curtain down entirely — a wrong date discovered with a queue outside — set
      `LANDING_ENABLED=false` and recreate. That opens check-in for everyone immediately, which is
      the right failure direction: an event that starts early beats an event nobody can enter.

      Two things the curtain does **not** block, by design: `/admin`, and anyone who already holds an
      attendee session. A volunteer who checked in at T−4h keeps their pass while participants are
      still looking at the countdown.

- [ ] **Confirm the questionnaire**, if one is running tonight:

      ```bash
      docker compose exec app printenv SURVEY_PARTICIPANT_ENABLED SURVEY_VOLUNTEER_ENABLED \
        SURVEY_OPENS_AT SURVEY_CLOSES_AT ATTENDEE_SESSION_TTL
      ```

      Then read `/admin/survey`: it shows each audience's switch, the schedule in the event's time
      zone, and whether the questionnaire is open and why. Opening or closing it by hand is the
      control on that page, and needs both `export:read` and `survey:write`.

      `ATTENDEE_SESSION_TTL` must cover the span from the earliest switched-on audience's check-in
      opening to `SURVEY_CLOSES_AT` — volunteers' when theirs is on, since they open four hours
      early. The pass does not refresh a session, so an attendee who checked in at their door and
      only watched the pass since must still hold one when the questionnaire closes. Boot refuses a
      configuration that breaks this, so a recreate that fails to come back after a survey change
      names this in the log.

      A switch or a time is changed in `.env` and applied with `--force-recreate`, as below.

- [ ] Read the venue's egress address from the venue network with
      `curl https://cloudflare.com/cdn-cgi/trace`, or from the app's own logs once the first
      attendee has loaded `/checkin`. Put it in `TRUSTED_IPS`. This moves the room onto the relaxed
      tier — 2000/min on `/api/v1`, 600/min on `GET /checkin`, 1000/min on the web routes.

      Do this before volunteers check in, not after. At the 17/10 event it was forgotten and added at
      11:06, while volunteers had checked in from 08:40 under the strict tier
      ([event report](../reports/event-2026-10-17.md#rate-limiting)).

      Leaving it empty is survivable rather than fatal: the strict tiers (300 / 60 / 100) are sized
      to carry an event on their own, because carrier CGNAT puts an unpredictable share of attendees
      behind addresses nobody can list in advance. Setting it buys headroom, not correctness.

      It matters more than it used to. The landing page sends each device to `/checkin` on its own
      random delay of up to 90 seconds once the countdown runs out, precisely so the room does not
      arrive in one second — but a few hundred phones inside 90 seconds still leans on `GET /checkin`
      harder than a staggered queue ever did. The jitter window is `NAVIGATE_JITTER_MS` in
      `src/web/client/pages/landing/index.ts`; widen it if the head-count grows.

- [ ] **Apply it with `--force-recreate`, not `restart`.** This is the step that will silently do
      nothing under pressure if you get it wrong:

      ```bash
      docker compose up -d --force-recreate app
      docker compose exec app printenv TRUSTED_IPS    # must echo what you just set
      ```

      The `environment` Compose builds from `.env` is read when the container is **created**, so its values are baked into the
      container's environment. `docker compose restart` reuses that environment and re-reads
      nothing. Nor does `dotenv` rescue it: `config/env.ts` loads the file from the bind mount, but
      dotenv does not override a variable that is already set — and a variable set to the empty
      string still counts as set. So a `.env` edit followed by a restart leaves the app reading the
      old value with nothing in the logs to say so. Verified the hard way: a trusted-tier test
      showed the relaxed quota never engaging until the container was recreated.

      A malformed entry throws at startup by design, so if the app does not come back, the log
      names the offending entry.

- [ ] Then confirm the tier actually engaged — the strict boundary from check 13 above should move
      from #61 to #601 for a request arriving from inside that range. Measured, both tiers:

      | Route         | Untrusted, first 429 | Trusted, first 429 |
      | ------------- | -------------------- | ------------------ |
      | `GET /checkin` | #61                 | #601               |
      | `/api/v1`      | #301                | none in 400 (quota 2000) |

- [ ] **Confirm load shedding is on.** Past the host's knee it is what keeps the event correct: in
      the load test, shedding off returned server errors and lost flows where shedding on returned
      none ([`load-testing.md`](../performance/load-testing.md#what-the-numbers-mean-for-an-event)).

      ```bash
      docker compose exec app printenv LOAD_SHED_ENABLED   # prints true, or nothing (default on)
      ```

---

## Updating a running deployment

**Before cutting a release, `npm run check` must report `skipped 0`.** A skipped suite is not a
failure, so `check` stays green without Docker or the pinned images; the Caddyfile and export-SQL
tests then never ran. The images to pull are in the README's
[Development section](../../README.md#development).

```bash
git fetch --tags
git checkout <tag>
docker compose build
docker compose --profile tools run --rm --build migrate   # if there are new migrations; see step 5
docker compose up -d
```

`up -d` recreates only what changed. Expect brief `cloudflared` connection churn in the logs while
old QUIC connections tear down — that is normal, and `curl` against the public hostname is the test
that matters.

**Recreating `app` needs no proxy restart.** While `app` is down and booting (about a second), `proxy`
holds each request for up to 5 s (`lb_try_duration`) and re-checks `/healthz` every 2 s
(`health_interval`), so visitors see a short wait rather than a `502` or `503`. Before this, a health
check that landed during the recreate left every request at `503` for up to 30 s, which looked like a
broken proxy. If `:80` still answers `503` more than a few seconds after `docker compose ps` shows
`app` healthy, the cause is elsewhere (load shedding, `docker compose logs proxy`), and restarting
`proxy` is not the fix.

**If a change has to ship during an event, recreate only `app`.** Use `docker compose up -d --force-recreate app`, and never
stop `db` or `cache` while attendees are active. At the 19:00 deploy on 17/10 they were stopped
with the app, the shutdown timed out, three requests got `503` and a telemetry batch was lost
([event report](../reports/event-2026-10-17.md#the-1900-deploy)).

**Some changes invalidate live sessions.** The session key format is part of the Redis key, so a
change there drops everyone mid-check-in. Deploy before an event, never during.

### One-off steps for the release that hardens sessions

Release of `develop` to `main` that carries migration `025_app-events-actor-digest.ts` and the
administrator session fix. Do these in order, before an event.

1. **Migrate before restarting the app.** Migration 025 rewrites raw session IDs in
   `app_events.actor_id` to digests, and a process still on the old code keeps writing raw IDs until
   it restarts. Run `migrate` (step 5) first, then `docker compose up -d`. Re-running the migration's
   `UPDATE` by hand afterwards is safe, because a digest is never UUID-shaped.
2. **Force administrators to sign in again** once the new code is live. A session copied off the
   Limits panel before the fix stays valid for up to 12 h:

   ```sh
   docker compose exec -e REDISCLI_AUTH="$REDIS_PASSWORD" cache \
     sh -c 'redis-cli --scan --pattern "session:admin:*" | xargs -r redis-cli DEL'
   ```

---

## Rollback

```bash
git checkout <previous-tag-or-sha>
docker compose build
docker compose up -d
```

Schema migrations are **not** automatically reversible. `migrate:down` exists, but some `down`
paths deliberately fail rather than lose data — `003_widen-ticket-code` refuses to narrow
`ticket_code` back to `varchar(5)` while any six-character code exists, because silently
truncating a ticket code would lock out the attendee holding it.

Roll the application back first, and treat a schema rollback as a separate, deliberate operation
with a backup in hand.

**If the application is failing on database permissions**, the fast recovery is not a schema
rollback — point `POSTGRES_USER` and `POSTGRES_PASSWORD` at the superuser pair and
`docker compose up -d --force-recreate app`. That restores service in seconds at the cost of the
privilege boundary, buying time to find the missing grant. Put it back afterwards.

---

## Operations

**Administrator accounts.** `/admin` answers on two routes: the public hostname, behind Cloudflare
Access, and the tailnet on `ADMIN_URL`, which bypasses Cloudflare entirely and is the fallback if the
edge misbehaves (see [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) § 3). There is no sign-up and no
seeded default — the first account is created from a shell:

```bash
docker compose run --rm migrate node scripts/admin/create-admin.ts \
  --username joshua --scopes attendees:read,attendees:write
```

`--username` may also be an email address (`joshua@example.com`), up to 64 characters; either form is
stored lowercased. The password is prompted for twice and never echoed. It is deliberately not a flag: that would put
it in shell history and in the host's process list.

**Adding a walk-in.** `/admin/attendees` → *Novo participante*, for anyone who arrives without being
on the roster. Leave the ticket code blank and the system issues one: `dXXXXX` for a participant,
`vXXXXX` for a volunteer. The `d` key is reserved — the roster import refuses it — because a code
generated under a key the sign-up system also uses could collide with one that system has not issued
yet, which no constraint can catch at the moment of generation.

The new attendee gets a working entry link straight away, from migration 004's column default, so
nobody chooses one and nobody has to. Requires `attendees:write`.

**Redemption items.** T-shirt, meal, drink and lunch are dropdowns of the approved values in
`src/web/content/redemption-options.md`. A value imported with the roster that is not on the list
stays selected and saves unchanged while the role is unchanged, marked *fora da lista*. After
loading the roster, run the off-list query in [`redemption-options.md`](../features/redemption-options.md#finding-off-list-records) so
those are fixed before the door opens rather than at the counter. Lunch is volunteer-only: saving
it on a participant is refused.

**T-shirt desk account.** The team handing over purchased t-shirts at `/admin/tshirts` needs one
account holding `tshirt:redeem` and nothing else. Create it, or narrow an existing one with
`set-admin-scopes.ts --username <name> --scopes tshirt:redeem`:

```bash
docker compose run --rm migrate node scripts/admin/create-admin.ts \
  --username <name> --scopes tshirt:redeem
```

The record page shows the attendee's verification code; see [`admin-scopes.md`](../features/admin-scopes.md#tshirtredeem).

**Retiring someone: archive, not delete.** A duplicate registration, a cancellation or a row created
by mistake is archived from the roster. That is a real disable rather than a filter on one screen —
an archived attendee cannot check in, cannot open their pass, cannot be served at a redemption
counter and is not in the raffle pool — and it takes effect on their **next request**, so somebody
holding an open pass loses it the moment they touch anything. Restore is the same button.

Nothing is deleted: the schema has no foreign keys, so removing a row would silently orphan its
redemption and raffle records, which is the same reason
[`data-retention.md`](../security/data-retention.md) has the purge scripts redact rather than delete.

```bash
docker compose run --rm migrate node scripts/admin/list-admins.ts
docker compose run --rm migrate node scripts/admin/set-admin-scopes.ts --username joshua --scopes attendees:read
docker compose run --rm migrate node scripts/admin/set-admin-scopes.ts --username joshua --disable
docker compose run --rm migrate node scripts/admin/set-admin-password.ts --username joshua
```

Scopes are **replaced**, not merged, so narrowing someone is as easy as widening them; pass
`--scopes ''` to strip them all. Every change takes effect on that administrator's **next request** —
the gates re-read Postgres rather than trusting the session — so there is nobody to sign out and no
TTL to wait through. Disabling an account is immediate in the same way.

These scripts connect as the **migrator** role, not the application role. Migration `013` withholds
`INSERT` and `DELETE` on `admins` from the app, so nothing reachable from an HTTP request can mint or
remove an administrator; provisioning has to come from a shell on the host. The valid scope names
live in `src/constants/admin-scopes.ts`, which is also what the table's `CHECK` constraint is built
from. What each one grants, and which to give each job: [`admin-scopes.md`](../features/admin-scopes.md).

**Volunteer lookup accounts — two halves, both required.** A volunteer working the door with the quick
lookup screen needs an account *and* a way to reach the surface. Provisioning one without the other
produces someone standing at the door holding credentials they cannot use — which is the whole reason
this is written as two halves rather than one step.

```bash
docker compose run --rm migrate node scripts/admin/create-admin.ts \
  --username <name> --scopes attendees:read,checkin:write
```

`attendees:read` is what opens the screen; `checkin:write` is the privileged action inside it —
marking someone present by hand, which bypasses the QR verification step the rest of the system is
built on. A volunteer granted only `attendees:read` gets a lookup that reads and cannot mark, which
is a deliberate and useful middle setting: the record renders, and the confirm button is simply not
there.

**The screen is `/admin/lookup`.** Search by name, tap the person, and the record shows their ticket
code, whether they have arrived, and — behind a control that has to be opened — their **verification
code**, the last four digits of the registered phone. Treat that number the way you would treat a
ticket code: it is the shared secret the door checks. See
[`data-retention.md`](../security/data-retention.md) § _The second exposure_.

**Confirming a presence does not put a pass on the attendee's phone**, and a volunteer who does not
know that will conclude the button failed. It writes the check-in and issues the arrival number;
the attendee still has no session. Tell them to open `/checkin` and enter their ticket code and the
four digits — **the QR step is skipped automatically** for anybody already checked in, so no camera
is involved. The record page says this in a line of its own once the presence is registered.

Marking somebody twice is safe. The row is locked, the number already issued is returned, and the
sequence does not advance.

**Nothing a volunteer types is left on their phone.** The search term and the person's ID travel in
the request rather than in the address bar, so the browser's history records `/admin/lookup` and
nothing more — no name, no ticket code, no phone digits. That store is the one this project cannot
reach: it survives being signed out, being removed from the tailnet, and having the account deleted,
and on a phone signed into Chrome or iCloud it is copied off the device.

The visible cost of that is one dialog. **Reloading a page of results, or reaching one with the back
button, makes the browser ask whether to send the search again** — say yes, or search again; it is
not a fault. Tapping *Voltar* from a record never raises it. Tell volunteers this once, or they will
report it.

**The second half is an email address on the Cloudflare Access policy.** Add it in Zero Trust → Access
→ Applications, on the administrator application's Allow policy, as an explicit address rather than a
domain. Then the volunteer:

1. Opens the public `/admin` link on their own phone.
2. Types their email address and receives a six-digit code.
3. Enters the code, and lands on the application's own sign-in form.

That is the whole of it — no account to create with Cloudflare, no client to install, no device
approval to wait for. The session lasts 24 hours, comfortably longer than an event.

**A volunteer whose address is not on the policy sees no error.** Cloudflare shows the same code-entry
screen and silently sends nothing, so that the form does not leak who is authorised. The symptom is "the
code never arrived", and the first thing to check is the spelling of the address on the policy.

**The tailnet is the fallback, and it still works.** `/admin` also answers on the `:8080` listener,
which `Caddyfile` accepts from `172.30.0.250` alone — the Tailscale sidecar. Worth having a phone
enrolled on the night in case the edge misbehaves:

1. Install Tailscale on the phone and sign in to **this** tailnet.
2. Confirm the device appears in the Tailscale admin console, and approve it if device approval is
   turned on for the tailnet.
3. Open `ADMIN_URL`. The sidecar terminates TLS with the `ts.net` certificate and forwards to Caddy.

**Reach is not permission, by either route.** Every device on the tailnet can reach `/admin/login`, and
so can everybody on the Access policy; the account and its scopes are the only thing limiting what
happens after that. Add addresses and devices for the event with the same care as accounts, and remove
them afterwards — an address is revocable individually and takes effect immediately, which is the one
thing the tailnet grant was never good at.

**The sign-in form carries a Turnstile widget.** It appears above the submit button and usually solves
itself without a tap. If it does not appear, or will not solve, the volunteer cannot sign in and the
remedy is not theirs — tell whoever is coordinating. They can switch the check off in under a minute:
set `TURNSTILE_ADMIN_ENFORCE=false` and recreate the app with
`docker compose up -d --force-recreate app`; a `restart` keeps the old value. That leaves sign-in standing on Cloudflare
Access and the password alone, which is an acceptable place to be for an evening and not a place to
stay. Put it back to `true` afterwards. While it is `false` in production the app logs a
`warn` line at startup saying so; set it back to `true` once Turnstile recovers.

One trap to know before the event: `ADMIN_SESSION_TTL` is one hour, sliding, with a twelve-hour
ceiling — sized for a desk tool. A volunteer working a five-hour event with the phone in a pocket
between lookups will be signed out repeatedly, on a phone, at a door. It is now the shortest of three
clocks running on that phone — the Access session is 24 hours and the zone's challenge clearance is 16 —
which means it is also the only one likely to interrupt them. Decide that deliberately
rather than discovering it on the day — and note that it now costs more than it did: because a
search is submitted rather than bookmarked, somebody signed out mid-lookup comes back to an empty
box and retypes the name.

**Logs.** The app writes to two places, and they answer different questions:

- **stdout** carries everything at `LOG_LEVEL`, one line per request included. Structured JSON in
  production (`pino-pretty` is development only). Docker rotates it at 5 × 10 MB and **deletes it
  with the container**, so a `--force-recreate` takes the evening's history with it.
- **`/var/log/pelicanpass/`** on the `logs` volume carries `warn` and above — every 4xx, 5xx, client
  error report and crash. Rotated at 5 × 10 MB, with `current.log` always pointing at the live file.
  It survives a recreate and is the record the alerts mean by _the durable log_. It holds IPs; see
  [`data-retention.md`](../security/data-retention.md).

Every line is one JSON object. The fields worth filtering on: `level` (40 `warn`, 50 `error`, 60
`fatal`), `msg`, `req.id` — the request id, which is also the `X-Request-Id` response header and
`request_id` in `app_events` — `req.url`, `res.statusCode`, and `code` on error lines.
`--no-log-prefix` is what lets `jq` parse the stdout stream at all:

```bash
# Live, readable
docker compose logs -f --no-log-prefix app | jq -R 'fromjson? // .'

# Live, errors and crashes only
docker compose logs -f --no-log-prefix app \
  | jq -cR 'fromjson? | select(.level >= 50) | {time, msg, code, path, id: .req.id}'

# Live, one line per failed request
docker compose logs -f --no-log-prefix app \
  | jq -cR 'fromjson? | select(.res.statusCode >= 400)
            | {time, id: .req.id, method: .req.method, url: .req.url, status: .res.statusCode}'

# Live, browser error reports as they arrive
docker compose logs -f --no-log-prefix app \
  | jq -cR 'fromjson? | select(.msg == "Client error reported") | {time, clientMessage, url, clientRelease}'

# Everything about one request, stack included
docker compose logs --no-log-prefix app | jq -cR --arg id '<request-id>' 'fromjson? | select(.req.id == $id)'

# The durable file: follow it, or search every rotation, including before a recreate
docker compose exec -T app tail -F /var/log/pelicanpass/current.log | jq -R 'fromjson? // .'
docker compose exec -T app sh -c 'cat /var/log/pelicanpass/app.*.log' \
  | jq -cR 'fromjson? | select(.level >= 50)'
```

The filters work the same on either source. `time` is epoch milliseconds, in UTC; insert
`.time |= (./1000 | todate) |` straight after `fromjson? |` to read it as a date.

**`app_events` is the same failures, grouped.** Every `warn`+ HTTP error, client error report and
security event also lands there with a `fingerprint` — the same one the Errors panel groups by
and alerts deduplicate on. Query it as the read-only role:

```bash
docker compose exec -T db sh -c 'psql -U "$READONLY_ROLE" -d "$POSTGRES_DB"' <<'SQL'
-- The loudest failures of the last half hour
SELECT fingerprint, kind, code, count(*) AS n, max(occurred_at) AS last_seen,
       min(left(message, 80)) AS message
FROM app_events
WHERE occurred_at > now() - interval '30 minutes'
  AND (severity IN ('error', 'fatal') OR kind = 'client_error')
GROUP BY fingerprint, kind, code
ORDER BY n DESC
LIMIT 20;
SQL
```

Swap the `WHERE` for `request_id = '<request-id>'` to find the row behind a log line, or
`fingerprint = '<signature>'` for every occurrence behind a _New error_ alert, whose `signature`
field is that fingerprint.

**Backups.** The `data` volume holds Postgres. Take a dump before the event and before any schema
change:

```bash
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > backup-$(date +%F).sql
```

`POSTGRES_USER` inside the `db` container is the **bootstrap superuser** — Compose maps
`POSTGRES_SUPERUSER` onto the name the image insists on. A dump needs to read every table, so this
is one of the few things it is for. The application's own role is `$APP_ROLE` in that container.

**Ticket printing.** Entry links carry an opaque token, not the ticket code. Export both, as the
read-only role:

```bash
docker compose exec -T db sh -c 'psql -U "$READONLY_ROLE" -d "$POSTGRES_DB" -c \
  "SELECT ticket_code, ticket_link_token FROM attendees ORDER BY ticket_code"'
```

Links are `https://<host>/checkin?t=<ticket_link_token>`. The raw ticket code is **not** a valid
entry link — it is only accepted at the manual entry step.

A link opened from another site (the browser reports `Sec-Fetch-Site: cross-site`, as a link inside
another website can) writes no session on the `GET`: `/checkin` answers a "Continuar" page whose
button posts the token back from this origin, and that `POST /checkin` performs the entry. A link
typed, bookmarked or opened by an app (`none`), or followed within the site, enters as before.

**Health.** `/healthz` is liveness only: it answers without touching Postgres or Redis, so a brief
database blip cannot get the container restarted mid-event. Caddy uses the same endpoint to stop
routing to a dead upstream.

**If Redis goes down mid-event.** Check-in, the pass, the volunteer staff page and the raffle stop working — sessions live in Redis, so there is no
degraded path that still checks people in or opens a pass. What the app does instead is fail in ~0.1 s with a 503
rather than hanging (`Retry-After: 5`, logged at `warn`), keep enforcing every rate limit from an in-process tier, and keep the global
captcha flag accurate. `/healthz` stays 200, so Caddy keeps routing and the container is not
restarted out from under you.

**Do not restart the app.** It reconnects on its own the moment Redis is back, and a restart loses
the in-memory limiter state for nothing. Bring the cache container back and re-run a check-in:

```bash
docker compose start cache        # or: docker compose up -d cache
docker compose logs app --tail 5  # expect "Redis ready", no restart
```

In-flight check-ins are lost — their sessions were in Redis. Attendees re-enter through
`/checkin` and start the flow again; nobody who already completed is affected, because completion
is a Postgres write.

**Data retention.** This host is torn down roughly **24 hours after the event**, and that teardown
_is_ the retention policy — there is no 30-day calendar entry, because there will be no server to run
one on. What matters is what leaves the box first. Full procedure in
[`data-retention.md`](../security/data-retention.md); the short version is below.


---

### Watching the event — alerts, the panel, and what to do

Three surfaces, in the order you will reach for them: **Discord** tells you something changed,
**`/admin/metrics`** tells you what, and the **logs** tell you why.

If the host itself is gone — power, uplink, or a boot that will not finish — none of the three
answers. Fail over to the warm standby instead: [`standby.md`](./standby.md) § 5.

`ALERT_ENABLED=false` turns delivery off without turning the rules off — they still evaluate
and still log, which is what a rehearsal wants and what event day does not. Set it to `true`
before the doors.

#### The twelve alerts

| Alert | Means | Do |
| --- | --- | --- |
| **Application started** | The process came up. Carries `release`. | Nothing — *unless no clean-stop notice preceded it.* See below. |
| **Application stopped cleanly** | `SIGTERM`/`SIGINT` was handled: connections drained, telemetry flushed. | Nothing. This is what a deliberate restart looks like. |
| **Process crashed and is restarting** | Something escaped every handler; the process is exiting and Docker will restart it. | Read the durable log for the stack. A bug, not a blip — expect it to recur. |
| **Redis is unreachable — sessions are gone** | Two consecutive probe failures. Every attendee-facing page and check-in call answers `503` with `Retry-After: 5`; the admin surface is unaffected. | `docker compose ps cache`, then `logs cache`. Rate limiting keeps working on its memory tier, so the limiter logs will *not* point here. |
| **Redis is back** | It recovered. | Confirm the Door panel is moving again. |
| **Postgres is unreachable — nothing can be written** | Two consecutive probe failures. No check-in, redemption or draw can be recorded. | `docker compose ps db`, then `logs db`. Check disk before assuming the process. |
| **Postgres is back** | It recovered. | As above. |
| **Queue at the door — no check-ins completing** | Thirty **check-in** requests over three minutes with zero completions, window open. | The one alert meaning *the room is filling up*. `/readyz` first — it names the failing dependency. Almost always Redis. |
| **Server errors above normal (N/min)** | More than 5 × 5xx in a minute. | Errors panel → loudest signature → expand for the scrubbed message. |
| **Rate limits are refusing traffic (N/min)** | More than 50 × 429 in a minute. | Limits panel. Read the fan-out column before touching a ceiling — see the decision procedure below. |
| **Frontend errors above normal (N/min)** | More than 20 client reports in a minute. | A bundle failing on some class of phone. The Errors panel groups them by signature. |
| **Admin sign-in blocked after repeated failures** | Ten failed sign-ins for one username in fifteen minutes; that username is locked out. | The username is in the **log line**, deliberately not in the alert. Grep the durable log. |
| **Captcha now forced for every arrival** | Thirty failed ticket lookups in a minute, so the door raised a captcha for everyone until the budget refills. | Expected during a rush of mistyped codes. If it persists, the roster or the printed codes are wrong. |
| **New error, first time since boot** | A failure shape not seen since the process started. | Fires once per shape. A burst right after a deploy means the deploy. |

**Every alert carries its own `means` and `check` lines**, so the message is readable without
this table open. This table is the fuller version, not the only one.

**A boot notice with no clean-stop notice before it is the crash signal.** Nothing announces
a `SIGKILL` — the OS does not let it — so the *absence* of "stopped cleanly" is the only
evidence that a restart was not deliberate. It is the one alert you read by what is missing.

#### Where browser errors come from

The bundle both page layouts load installs `src/web/client/core/telemetry/report-error.ts`, which
listens for uncaught
`error` and `unhandledrejection` events and posts each to `POST /api/v1/client-errors`. What that
does and does not catch:

- **Caught:** script errors and rejected promises nothing handled, with message, stack, line,
  column, page URL and the bundle's release.
- **Not caught:** a failed image or stylesheet (no error object — that is the network panel's),
  and the API outcomes the interface already has a screen for: a mistyped code, a captcha, a rate
  limit, a closed window. At the door those are the commonest responses there are, and reporting
  them would bury the defects.
- **Bounded:** at most five reports per page load, one per distinct error, and the endpoint's own
  limits on top ([`rate-limiting.md`](../performance/rate-limiting.md)). A phone in an error loop cannot flood
  the door it is reporting on.

The server masks the `?t=` entry token out of the URL, logs a `warn` line —
`"Client error reported"`, with `clientMessage`, `url` and `clientRelease` — and records a
`client_error` row in `app_events`. It is deliberately **not** `error`, so a single browser
extension on a single phone cannot raise _New error_; the **Frontend errors above normal** spike
rule is the only alert this path raises. To see individual reports, use the client-error recipe
under [_Logs_](#operations) or group them by fingerprint in `app_events`.

#### Silencing a noisy fingerprint mid-event

There is no per-alert mute, on purpose: a mute outlives the incident and the next person
does not know it is there. What exists instead:

- Every alert deduplicates by fingerprint for `ALERT_DEDUP_TTL` (default `10m`), and the
  next message says how many firings it stood for — `×47 since 20:14`. A noisy rule is
  already one message every ten minutes, not a flood.
- If that is still too much, widen `ALERT_DEDUP_TTL` and recreate the app with `docker compose up -d --force-recreate app`. It applies to every rule.
- To stop *everything*: `ALERT_ENABLED=false` and recreate the app the same way. The rules keep evaluating and
  keep logging, so the panel and the file are unaffected. Do this only if the channel has
  become unreadable, and say so to whoever else is watching it.

**The door-stalled rule counts check-in traffic only** — `/checkin` and `/api/v1/checkin`,
regardless of status code. It used to count every request the process served, which included
this dashboard's own five-second poll: 36 requests across its three-minute window against a
threshold of 30, so leaving the panel open raised a critical alert with nothing at the door.
An idle dashboard can no longer trigger it.

#### Reading `/admin/metrics` under load

The panel polls every five seconds and shows a countdown to the next refresh. **If the
countdown reaches zero and stays there, the numbers on screen are stale** — the state text
turns amber and the arc with it. That is the failure the countdown exists to make visible;
a dashboard showing frozen numbers as though they were live is worse than one showing
nothing.

Each card has an explainer on hover, and so does every limiter row. **This screen is in
English**, unlike the rest of the admin surface — it shares a vocabulary with the alerts that
feed it rather than with the rail that frames it. The two worth knowing before you need them:

- **Door** — the per-minute rate is the *current* minute, so it drops to zero between
  arrivals. The sparkline is the last sixty minutes and is what tells you whether the door
  is moving.
- **Latency** — the values are bucket edges, not measurements. `≤ 250 ms` means the
  percentile falls in that bucket. Do not read it as a number.

#### The Limits decision procedure

This is the panel that answers "are we hitting limits, and is it us or them". One row per
limiter — **and per tier**: a tiered limiter shows `rl:ip` and `rl:ip:trusted` separately,
with their own ceilings, so moving an address between them is visible rather than hidden in
a merged row. Each row: peak against the tier's real ceiling, refusals this minute, and the busiest keys.
Amber past 80 %, red on any refusal.

When a row goes red, **fan-out is what tells you which problem you have**:

- **Many distinct sessions behind one address** — dozens or hundreds — is a carrier NAT or
  the venue wifi. The room is behind one IP and the limiter is doing the wrong thing to the
  right people. Add the address to `TRUSTED_IPS` and recreate the app with
  `docker compose up -d --force-recreate app` (a `restart` keeps the old value); the tiered limiters move it to
  the trusted quota (`ipLimiter` 2000/min instead of 300, `checkinEntryIpLimiter` 600
  instead of 60).
- **One session, or a handful, making all the traffic** is a single client in a loop, or
  somebody guessing. Leave the ceiling alone — it is working.

Volume alone cannot separate those two, which is the entire reason the fan-out column
exists. Read it before touching a ceiling.

**Prefer `TRUSTED_IPS` to raising a ceiling.** It relaxes the room without loosening the
limiter for everyone else. When a ceiling itself is wrong, the defaults live in
`src/config/rate-limits.ts` and any one can be overridden for the night with
`RATE_LIMIT_OVERRIDES` in `.env` — see
[`rate-limiting.md` § Overriding a quota](../performance/rate-limiting.md#overriding-a-quota). Either
needs `docker compose up -d --force-recreate app`, not `restart`.

#### The dead-man's switch

Every mechanism above runs **on the host it is watching**, so none of them can tell you the
host is gone. That needs something off the box.

Pick one, and write down which is in use:

- an external uptime monitor polling `https://<host>/healthz` with a Discord
  notification — the simplest, and it transmits only up/down;
- a Cloudflare Health Check with a webhook notification — **verify plan eligibility first**,
  standalone health checks are not on every tier;
- a two-line cron on any second machine, posting to the same Discord webhook.

Two things to know before wiring it:

- **`/healthz` is public on purpose, at both layers.** The Caddyfile answers 403 for
  `/readyz` through the tunnel because it discloses dependency state, and deliberately
  leaves `/healthz` open — Caddy's own upstream check uses it, and it answers `ok` without
  touching Redis or Postgres. At the edge, custom rule 2 excludes the path from its Managed
  Challenge, which a monitor cannot solve; see
  [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) § 2.
- **The monitor must probe from Brazil.** Custom rule 1 blocks every non-BR address, `/healthz`
  included, so a monitor polling from abroad reports the site down permanently.
- **Bot Fight Mode can still refuse the monitor.** Nothing exempts a path from it on this
  plan, and most monitors poll from data-centre ASNs. A 403 in the monitor's own history,
  rather than from a `curl` on this host, is the symptom.
- **It tests the whole chain, not the host.** The path is Cloudflare → cloudflared → Caddy →
  app, so an edge incident and a dead VM page identically. That is the right trade — all of
  those mean attendees cannot reach the door — but do not spend the first five minutes of an
  outage on the wrong box.

### WhatsApp runs

Pre-run checks, what the delivery panel does not show, and what to do when a run stalls or
comes back mostly `undelivered` are in
[`whatsapp-integration.md`](../features/whatsapp-integration.md) § _Operating notes_.

## Teardown

Run in this order. The export happens before the volume is destroyed and there is no second attempt.

```bash
# Load the credentials and event the commands below read on the host. Compose
# reads .env for itself; it does not export it to this shell.
set -a; . ./.env; set +a
echo "migrator=$POSTGRES_MIGRATOR_USER readonly=$POSTGRES_READONLY_USER db=$POSTGRES_DB event=$EVENT_ID"
#    none empty, and event is the real id, not the .env.example placeholder

# 0. Forget who answered the questionnaire, and close it. The privacy notice
#    promises that record is gone before the final report, so this runs before
#    the exports. It costs the results export nothing: that file carries no name
#    or phone, and the ticket code it keeps is not touched.
docker compose exec -T db psql \
  -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/purge-attendees.sql    # expect completions_remaining = 0, survey_override = closed

# 1. Export what you are keeping — no phone, no name, read-only role.
docker compose exec -T db psql \
  -U "$POSTGRES_READONLY_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/export-results.sql > checkin-results.csv

#    The questionnaire's answers, one anonymous file per audience, also as the
#    read-only role. The volunteer file is a header alone if volunteers had none.
docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience participant > survey-participant.csv
docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience volunteer > survey-volunteer.csv

#    To turn these files into the post-event report, see
#    docs/operations/event-report.md.

#    The evening's traffic, anonymous: request rates per limiter, how requests
#    spread over addresses, entry failures. The request log is the only record
#    of successful requests and dies with the container; this keeps its shape
#    for calibrating the load test, not the log.
#    WARNING: this reads the container's stdout, which every recreate discards.
#    Capture it right after the event, before any deploy or restart. At the
#    17/10 event it ran at teardown and covered only the post-event day.
docker compose logs app --no-log-prefix \
  | docker compose exec -T app node scripts/telemetry/traffic-summary.ts \
  > traffic-summary.md

# 2. Check what you are about to keep, before anything is destroyed.
head -1 checkin-results.csv | grep -c 'phone\|name'   # expect 0
wc -l checkin-results.csv                             # roster count + 1
head -1 survey-*.csv | grep -ci 'name\|phone\|ticket' # expect 0
wc -l survey-*.csv                                    # each: /admin/survey's count + 1
grep -cE '([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){3,}' traffic-summary.md # expect 0
head -5 traffic-summary.md                            # the window should span the evening

# 3. Capture the telemetry, if it is wanted. Both die with the volumes below.
#    The log file holds IPs and actor ids; app_events holds the same plus
#    scrubbed context. Neither is anonymous — see data-retention.md.
docker compose cp app:/var/log/pelicanpass ./logs-archive
docker compose exec -T db pg_dump -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -t app_events > app-events.sql

# 3b. Keep the public hostname answering, so it shows the closing page rather
#     than a Cloudflare error once this host is gone. The static site needs no
#     machine: see static-site.md § 4, then open the public URL and confirm the
#     closing page before going on. If it is not ready, hand the hostname to the
#     fallback as a stopgap; its .env carries the same EVENT_CLOSES_AT. See
#     fallback.md § 3 and § 5.

# 4. Destroy the stack and its data. -v is what removes the volumes; without it
#    the phone numbers outlive the containers on a host nobody watches now.
docker compose down -v
docker volume ls | grep pelicanpass                      # expect nothing

# 5. Delete every pg_dump taken during the event — host, laptop, chat message.
#    Step 3's captures count: they are on the same schedule as the attendee data.
#    So does the warm standby: ~/standby on both hosts and dev-server's standby
#    volumes. See standby.md § 9.
```

Step 5 is the one that gets skipped, and it is the only one that can undo the others. A dump
carries every attendee's phone number in plaintext.

**Step 3 is optional and has a cost.** Skipping it loses the evening's error history and the
durable log; taking it creates two more files carrying personal data, on the same deletion
schedule as the dumps. If the telemetry is being kept for a post-mortem, run
`scripts/db/purge-attendees.sql` first — it nulls `app_events.ip`, `actor_id` and `context`
while leaving the fingerprints, codes and routes that make the history useful. The log file
has no such purge and no SQL can reach it; keep it only if the addresses in it are acceptable
to keep.

**If a full dump has to be kept**, purge before dumping rather than after:

```bash
set -a; . ./.env; set +a
echo "migrator=$POSTGRES_MIGRATOR_USER readonly=$POSTGRES_READONLY_USER db=$POSTGRES_DB event=$EVENT_ID"
#    none empty, and event is the real id, not the .env.example placeholder
docker compose exec -T db psql \
  -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/purge-phone.sql          # expect phones_remaining = 0
```

Names survive that one; `scripts/db/purge-attendees.sql` takes those too and rotates
`ticket_link_token` so printed links stop resolving. Both refuse to run as the application role.

**The export is pseudonymous, not anonymous.** `ticket_code` re-identifies against the roster the
attendees came from. Drop that column from `export-results.sql` if the file is going anywhere the
roster's owner would not.

**The survey files are anonymous**: no attendee column, no timestamp, and rows in random order. Two
limits are not technical, and whoever receives them should hear both: a free-text answer can name
its author, and the volunteer file is far easier to re-identify by reading, because the group is
small and known. See [`data-retention.md`](../security/data-retention.md).

**Step 0 is also what the privacy notice promises.** It says the record of who answered is deleted
before the final report; running the purge first is what makes that true. It closes the
questionnaire in the same transaction, since with that record gone nothing would stop a second
answer.

---

## Known gaps at this revision

Deliberately not yet addressed; tracked in the
[overview's open items](../security/security-overview.md#open-items):

| Gap |
| --- |
| Cloudflare rate-limiting rule on `/checkin` not yet created — set it after the dry run. The **Limits** panel is now the instrument that produces the measured threshold this row was waiting for: drive the rehearsal and read the peak against the ceiling rather than guessing a number |
| UFW baseline not applied on the production host; Windows side not audited |
| `can_redeem`, `redeem_scopes` and `can_draw` are still set by hand in `psql`. The attendees editor **shows** all three on a record, so who is appointed is finally visible without a `SELECT` — but it cannot change them, and deliberately: migrations 008, 010 and 011 grant the application role `SELECT` and not `UPDATE` so that a compromised session cannot promote itself, and grants are role-wide rather than route-wide. Appointing a volunteer, moving them between stations, putting one on the raffle or standing any of them down is still a migrator-role `UPDATE`, one at a time from [`db-cheatsheet.md`](./db-cheatsheet.md) or in bulk with the [permissions import](./imports.md#volunteer-permissions-import). All take effect on that volunteer's next request, so they are fast; they are just not self-service |
| `adminSessionLimiter` caps an administrator at **20 requests per 60 seconds**, and entering walk-ins one after another at the door is the burst that reaches it. Each save is one request, so roughly twenty new attendees a minute. Widening it is a change to a security control sized for a desk tool, so it is a decision to take before the event rather than during one — and it can now be taken from a measurement: `rl:session:admin` is a row on the **Limits** panel with its real ceiling and peak. The live panel does *not* consume this budget; it has its own `metricsPollLimiter` at 60/min, mounted above `/admin` precisely so a five-second poll cannot starve the roster |
| `ADMIN_SESSION_TTL` is one hour, sliding, with a twelve-hour ceiling — sized for a desk tool, and a volunteer working a five-hour event with the phone in a pocket between lookups will be signed out repeatedly, at a door. It is now the shortest of three clocks on that phone (the Cloudflare Access session is 24 hours and the zone's challenge clearance 16), which makes it the only one likely to interrupt anybody. Raising it is a change to a security control, so it is a decision to take before the event rather than during one |
| A **hand-marked presence records no actor**. `completeCheckin` writes no `checked_in_by` column, so the only trace of who admitted somebody is one log line — `{ adminId, attendeeId, checkinNumber, source: 'admin' }`. It logs at `info`, so it goes to stdout and dies with the container; the rotating file on the `logs` volume takes `warn` and above only. **`app_events` did not close this**, though it is a table with a retention decision and looks like the answer: `checkin.complete` is a `domain` event, and `recordEvent` deliberately does not store those because `attendees` and `redemptions` are already their durable home. Closing this still needs a column and a retention decision, not a `grep`. That is the same gap the attendees editor recorded for its writes, and this is its sharpest instance: the volunteer lookup's confirm button stands in for both proofs the door normally requires, the verification code and the poster scan. Answering "who let this person in, and when" after teardown needs a table and a retention decision, not a `grep` |
| **Host disk encryption** is not enabled or verified. The plaintext name and phone columns rest on the assumption that the host disk is encrypted, and no runbook step checks it. The host is WSL2, so the filesystem is a VHDX on NTFS and BitLocker on the Windows volume is the only practical lever. If enabled it protects a drive removed and mounted elsewhere; it does **not** protect a machine stolen while powered on, nor a `pg_dump` copied to a laptop — see [`data-retention.md`](../security/data-retention.md) |

Neither blocks a deploy. The edge custom rules are in place
([`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md)); what remains is the single rate-limiting
rule, deliberately deferred until the dry run gives a measured threshold rather than a guessed one.

The container egress filter **is** applied and verified on the reference host — a container
can no longer reach the host, the LAN or the tailnet, while keeping internet access. What remains is
installing it on the production box and running §6 of
[`container-containment.md`](../infrastructure/container-containment.md) there, before and after a reboot.
