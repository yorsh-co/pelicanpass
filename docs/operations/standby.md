# Warm Standby

A second, complete production stack on dev-server that can take over from prod-server within minutes, with
check-ins, redemptions and signed-in phones intact. It is for the failures the
[landing fallback](./fallback.md) cannot cover: a mains cut longer than the UPS, a venue ISP outage,
or a host that will not boot while people are at the door.

|                       | Landing fallback          | Warm standby                                 |
| --------------------- | ------------------------- | -------------------------------------------- |
| Serves                | Countdown, privacy, terms | The whole app                                |
| Data                  | None                      | prod-server's, at most one minute old             |
| Sessions              | None                      | Kept — phones stay signed in                 |
| Secrets               | None                      | All of production's                          |
| Use it for            | A restart of a few minutes | prod-server gone for longer, or at a bad moment  |

---

## 1. How it works

```
every minute  dev-server ──ssh (forced command)──▶ prod-server: snapshot.sh ──▶ tar ──▶ validated ──▶ ~/standby/snapshots/
failover      dev-server: restore.sh latest ──▶ move SITE_HOST to dev-server's tunnel
cut-back      dev-server: cutback.sh ──▶ snapshot of dev-server ──▶ prod-server: restore.sh ──▶ move SITE_HOST back
```

A snapshot is one tar of three members:

| Member      | What                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| `db.dump`   | `pg_dump -Fc` as the migrator role: every table, sequence value and grant              |
| `cache.rdb` | A point-in-time RDB of Redis: sessions, rate-limit counters and idempotency records   |
| `meta`      | `taken_at`, `host`, `release`, `checkin_number_last`                                  |

Snapshots are **pulled**, not pushed. prod-server needs no new route, port or credential, and its
`data` network stays `internal`. A pull that fails leaves the last good snapshot in place, and every
snapshot is proven loadable (`pg_restore --list`, `redis-check-rdb`) before it is kept.

**Why the session survives.** Cookies are host-scoped and unsigned, and Redis keys are digests of
the cookie value. So the same public hostname plus the same keys gives the same signed-in phone.
The UA binding is still enforced. A restored RDB keeps each key's absolute expiry, so sessions keep
their remaining lifetime. Passes verify because `PASS_SECRET` is the same on both hosts.

**What a failover can lose** is whatever prod-server wrote after the last successful pull: at most a
minute of check-ins and redemptions. It is not destroyed, only stranded on prod-server, and §6 recovers
it. Two things stop that gap from doing harm:

- `restore.sh` advances `checkin_number_seq` by 500. A number prod-server issued after the snapshot is
  never issued again, and the raffle cannot call two people for one number.
- `restore.sh` dumps the database it is about to replace to `~/standby/pre-restore-<UTC>.dump`.
  It keeps the newest three and deletes older ones, as `cutback.sh` does for `cutback-*.tar`.

Measured on dev-server with a seeded roster:

| Step                                                   | Time   |
| ------------------------------------------------------ | ------ |
| Snapshot                                               | ~5.5 s |
| Pull with validation                                   | ~8 s   |
| Restore, through `/readyz` = `ready`                   | ~5 s   |
| Cut-back, from stopping dev-server's app to prod-server ready   | ~13 s  |

A full roster adds seconds to each, not minutes. The dashboard hostname move is the slowest part
of either direction.

## 2. Prepare prod-server — once, before the event

1. Check out the release tag that contains `scripts/standby/`, the same one production runs.
2. Make the rootless daemon the default Docker context, so a non-interactive SSH session reaches it:

   ```sh
   docker context use rootless
   ```

3. Authorize dev-server's **snapshot key** with a forced command. The key can run `snapshot.sh` and
   nothing else: no shell, no PTY, no forwarding. Generate it on dev-server with no passphrase, because a
   timer has nobody to type one:

   ```sh
   # on dev-server
   ssh-keygen -t ed25519 -N '' -C 'pelicanpass-standby snapshot' -f ~/.ssh/id_pelicanpass_standby
   ```

   ```sh
   # on prod-server, one line in ~/.ssh/authorized_keys
   from="<tunnel-side source address>",command="<checkout>/scripts/standby/snapshot.sh",restrict ssh-ed25519 AAAA… pelicanpass-standby snapshot
   ```

   dev-server reaches prod-server through Cloudflare Access (`cloudflared access ssh` as the `ProxyCommand`),
   so sshd never sees dev-server's own address. It sees wherever prod-server's `cloudflared` hands the
   connection off: loopback, or the rootless Docker gateway if that `cloudflared` runs in a
   container. `from=` must name **that** source address. Read it from dev-server over the real path:

   ```sh
   # on dev-server
   ssh prod-server-cf 'echo ${SSH_CONNECTION%% *}'
   ```

   `from=` then restricts the key to connections that arrive through the tunnel; it does not tell
   dev-server from any other tunnel client. Who can open that tunnel is the **Cloudflare Access policy
   for the SSH hostname**. Check that it admits only dev-server (a service token) and the operators
   (an identity policy), and revisit it whenever either changes. Use an absolute path for
   `<checkout>`. After installing the line, run `ssh prod-server-cf true` from dev-server to confirm the tunnel path still
   works, then start one pull (`systemctl --user start pelicanpass-standby-pull.service`) and check that
   a new file lands in `~/standby/snapshots/`. Do not test the snapshot key with `true`: the forced
   command ignores it and streams a snapshot.

## 3. Prepare dev-server — once, before the event

### The stack

1. Follow [`deployment.md`](./deployment.md) § First deploy into `/srv/prod/pelicanpass`, at the
   **same tag as prod-server**. The host has to be ready to serve, not just to restore.
   - Build every image now: `docker compose build`,
     `docker compose --profile tools build migrate` and `docker compose pull`. Nothing should
     download over a 5G link during an outage.
   - Run `db`, migrate once, then `docker compose stop`. A restore lands on a schema that already
     exists, with the same role names and the `pgcrypto` extension the restore expects.
2. Write `.env` as a twin of production's. Copy it from prod-server, mode `0600`, and change only these:

   | Variable                                            | On dev-server                                                       |
   | --------------------------------------------------- | --------------------------------------------------------------- |
   | `TUNNEL_TOKEN`                                      | A **dedicated standby tunnel**. Never production's: two connectors on one tunnel are load-balanced |
   | `TS_AUTHKEY`, `TS_HOSTNAME`, `ADMIN_URL`            | dev-server's own tailnet node                                       |
   | `POSTGRES_*_PASSWORD`, `REDIS_PASSWORD`             | Its own. A dump carries role names, not role passwords          |
   | `SERVER_NAME`                                       | `dev-server`                                                        |

   Everything else stays **identical**. That includes `PASS_SECRET` (passes),
   `ADMIN_PASSWORD_PEPPER` (admin logins), `EVENT_ID`, `SITE_HOST`, `APP_URL`, the event timing,
   Turnstile, Cloudflare Access, WhatsApp and Discord.
3. In the standby tunnel, route a spare hostname (`standby.<domain>`) to `http://proxy:80`, with
   _HTTP Host Header_ set to `proxy`. Opening it returns the proxy's status JSON with
   `"server": "dev-server"`, which proves the tunnel reaches this stack. It cannot carry the app itself:
   Caddy serves the app only on `SITE_HOST`, and `SITE_HOST` moves only at failover.
4. Add dev-server's tailnet hostname to the **admin Turnstile widget's** hostname allowlist, or the
   tailnet sign-in form refuses every token.

### The pull

1. Add an SSH alias for the snapshot key, beside the existing `prod-server-cf`:

   ```
   Host prod-server-cf-standby
       Hostname ssh.example.org
       User pelicanpass
       IdentityFile ~/.ssh/id_pelicanpass_standby
       IdentitiesOnly yes
       ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h
   ```

   It rides the same Cloudflare Access session as `prod-server-cf`. The Access session lasts a week, so
   renew it (`ssh prod-server-cf true`) the day before the event.
2. Write `~/.config/pelicanpass-standby.env`:

   ```sh
   STANDBY_LOCAL_DIR=/srv/prod/pelicanpass
   STANDBY_SSH_HOST=prod-server-cf-standby
   STANDBY_CUTBACK_SSH_HOST=prod-server-cf
   STANDBY_REMOTE_DIR=<prod-server checkout>
   ```

   Optionally, `STANDBY_MAX_SNAPSHOT_BYTES` sets the largest snapshot the pull accepts. It defaults
   to 268435456 (256 MiB), far above a snapshot of an event this size, and must be a positive
   integer. The pull stops reading at the limit, and every snapshot's tar is checked before it is
   extracted: it must hold exactly `meta`, `db.dump` and `cache.rdb`, each a regular file, with
   sizes totalling no more than the limit. `restore.sh` and `cutback.sh` apply the same check. A
   snapshot over the limit, or with any other member, is refused and not kept. That counts as a
   failed pull: the journal shows `snapshot is larger than … bytes` (or the member that was
   refused) and the notifications in § 4 follow the usual schedule. Raise the limit only if the
   database has genuinely grown past it. `restore.sh` reads the same file; set the variable on both hosts, since
   prod-server runs `restore.sh` at cut-back.

3. Install the units. They are symlinked so they track the checkout, and **not enabled**, because
   the timer runs only during the event:

   ```sh
   ln -s /srv/prod/pelicanpass/scripts/standby/pelicanpass-standby-pull.{service,timer} \
     ~/.config/systemd/user/
   systemctl --user daemon-reload
   ```

4. Prove one pull by hand:

   ```sh
   /srv/prod/pelicanpass/scripts/standby/pull.sh
   # kept 20261010T180000Z.tar (taken_at …, checkin_number_last …)
   ```

### Event day

- Stop the development and load-test stacks. `deployment.md` already requires this on an event
  host, and here they compete with the standby for memory.
- Disable suspend, and sleep on lid close. Confirm the clock is NTP-synced
  (`timedatectl | grep synchronized`): restored sessions expire by absolute time.
- Charge to full and bring external power. Postgres alone asks for `shared_buffers=2GB`.
- Run **only** `tunnel` and `vpn` on dev-server while it is a standby, or nothing at all. Never `app`:
  it would write telemetry into a database the next restore replaces.

## 4. During the event

```sh
systemctl --user start pelicanpass-standby-pull.timer
journalctl --user -u pelicanpass-standby-pull -f      # one "kept …" line a minute
```

The second failed pull in a row raises a critical desktop notification ("Standby snapshot
failing"), repeated every ten minutes. A recovery raises a normal one. **A failing pull is the
first sign that prod-server is gone**, often before anyone at the door notices.

## 5. Failover

**When.** Fail over when prod-server will not be back within about five minutes, or when it is down at a
moment that cannot wait: the doors, a redemption rush, the raffle.

**If prod-server is still reachable but going down** (UPS running out), lose nothing:

```sh
ssh prod-server-cf 'cd <checkout> && docker compose stop app'
/srv/prod/pelicanpass/scripts/standby/pull.sh
```

**Then, in either case:**

1. On dev-server:

   ```sh
   cd /srv/prod/pelicanpass
   scripts/standby/restore.sh ~/standby/snapshots/latest
   ```

   It shows the snapshot's age, release and last check-in number, and asks for `RESTORE`. It refuses
   a snapshot from a different release. It stops the pull timer, which freezes the last snapshot for
   §6. Then it restores, starts the stack and waits for `/readyz`.
2. In the Cloudflare dashboard, move `SITE_HOST` from production's tunnel to the standby tunnel, as
   in [`fallback.md`](./fallback.md) § 3.
3. Confirm the public `/healthz`, and one real pass on a phone that was signed in before.
4. Tell administrators on the tailnet to use dev-server's tailnet URL and sign in again there, because
   cookies are per origin. Administrators on the public path, behind Access, keep their session.
5. If a WhatsApp run was in progress, it is now **paused**: the runner pauses on boot and never
   resumes on its own. Check _Mensagens_ before resuming it, since a message prod-server sent after the
   snapshot would be sent again.

## 6. When prod-server comes back

prod-server restarts its stack on its own (`restart: unless-stopped`). It gets no public traffic,
because the hostname has moved. Its tailnet URL, however, still accepts writes into a stale
database. So first:

```sh
CHECKOUT=<prod-server checkout>   # the absolute path, as STANDBY_REMOTE_DIR
ssh prod-server-cf "cd $CHECKOUT && docker compose stop app"
```

Then recover the gap: whatever prod-server recorded after the snapshot dev-server restored. It never reached
dev-server. From the dev-server checkout, read the report of a dry run, then run it for real:

```sh
cd /srv/prod/pelicanpass
scripts/standby/recover-gap.sh --dry-run
scripts/standby/recover-gap.sh                # asks for REPLAY
```

The script needs the `migrate` image rebuilt after pulling:
`docker compose --profile tools build migrate`. It reads the start of the gap from the snapshot
`restore.sh` restored. `--since <taken_at>` replaces it, for the rare case that record is wrong.

What it does:

- Reads `~/standby/last-restore.meta`, which `restore.sh` wrote: when the restored snapshot was
  taken, its last check-in number and the reserve. It refuses if the last restore was a cut-back.
- Refuses while prod-server's `app` is running, so the gap cannot grow underneath it.
- Extracts the gap on prod-server with a read-only query. The gap holds personal data, so it is held in
  memory and never written to disk.
- Replays it in one transaction as the migrator role. It is all or nothing: any problem rolls
  everything back, and `--dry-run` rolls back even a clean run.
- Is safe to repeat. A second run reports 0 changes and lists everything as unchanged.

The rules:

- **Check-ins** keep prod-server's number and time, so a pass already printed with that number stays
  valid. Two attendees cannot share a number, because `restore.sh` reserved 500 above the snapshot's
  last one and dev-server issues above that.
- **Redemption rows** are copied verbatim, so the audit trail shows who really handed the item over.
- **Item state** is copied only where dev-server has no activity of its own on that item. Where both
  hosts changed it, dev-server's state is kept and the report says so.

### Reading the report

| Section                         | Means                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `Checked in`                    | Check-ins written, or that would be on a dry run                                   |
| `Redemption rows`               | Rows copied from prod-server's audit trail                                              |
| `Item state set`                | Items whose collected state was set from prod-server                                    |
| `Checked in again on dev-server — keeps its dev-server number` | The attendee came to the door again after the failover. dev-server keeps its number: tell them that is the one in the raffle |
| `Archived on dev-server — not checked in`, `Archived on dev-server — item state not changed` | Archived on dev-server since the snapshot, so nothing was written for them. Decide with the desk whether they still count |
| `Collected on both hosts — handed over twice` | The item was handed over at both hosts. Nothing to fix in the app: decide with the desk |
| `Changed on both hosts — dev-server's state kept` | One host collected it and the other did not. dev-server's state is kept: change it in `/admin/redemptions` if prod-server's was right |
| `Changed on prod-server in the gap by something other than a check-in or redemption` | Edited in the attendees editor on prod-server. Not replayed: compare those records by hand in the editor |
| `Raffle already drawn on dev-server — replayed numbers were not in that pool` | A draw ran on dev-server before these check-ins were replayed. Those attendees were not in it: tell whoever runs the raffle |
| `Problems`                      | Nothing was written. Fix the cause, then run again |

The notices change nothing and do not stop the run. A `Problems` list does, and the usual causes are:

- A ticket created on prod-server in the gap. Add it in the attendees editor on dev-server first, with the
  same code, then run again.
- A code dev-server does not know, or one held by another attendee or role on dev-server.
- A check-in number above the reserve: prod-server issued more than 500 check-ins in the gap. Use the
  steps below.

### By hand

Use this when the script cannot run. Read when the restored snapshot was taken:

```sh
TAKEN_AT="$(sed -n 's/^taken_at=//p' ~/standby/last-restore.meta)"
```

1. List what prod-server recorded after it. The outer double quotes expand `$CHECKOUT` and `$TAKEN_AT`
   on dev-server; the escaped `\$MIGRATOR_ROLE` and `\$POSTGRES_DB` expand inside the db container:

   ```sh
   ssh prod-server-cf "cd $CHECKOUT && docker compose exec -T db sh -c 'psql -U \"\$MIGRATOR_ROLE\" -d \"\$POSTGRES_DB\" -v t=$TAKEN_AT'" <<'SQL'
   SELECT ticket_code, checkin_number, checkin_at
   FROM attendees WHERE checkin_at > :'t' ORDER BY checkin_at;

   SELECT a.ticket_code, r.item, r.outcome, r.created_at
   FROM redemptions r JOIN attendees a USING (attendee_id)
   WHERE r.created_at > :'t' AND r.outcome IN ('redeemed', 'marked', 'reverted')
   ORDER BY r.created_at;
   SQL
   ```

   The second query leaves out `duplicate` and `not_entitled`: those were refusals and changed
   nothing.

2. On dev-server, for each row of the **first list** (check-ins), open the ticket on the admin lookup
   and press _Mark present_ (`checkin:write`). Skip anyone the lookup already shows as present:
   they came back to the door after the failover and hold a new number from dev-server. Their old
   prod-server number never existed on dev-server, so it cannot be drawn in the raffle.
3. On dev-server, for each row of the **second list** (redemptions), open the ticket on
   `/admin/redemptions` and apply the same change: mark the item collected for `redeemed` or
   `marked` with the reason _Entregue sem o sistema_, revert it for `reverted` with _Outro motivo_.
   Skip an item dev-server already shows in that state.

The gap is usually empty or a handful of rows: at most one pull interval, a minute, unless pulls
were already failing before the failover. Nothing here is time-critical. dev-server keeps
serving until a quiet session, and the [cut-back](#7-cut-back--in-a-quiet-session) keeps prod-server's
copy in its own safety dump if this has not been done.

## 7. Cut-back — in a quiet session

Hand production back to prod-server in a session where nobody needs the app. The app is unavailable for
the few minutes the cut-back takes.

**Before starting:**

- prod-server is on stable power and uplink, with its UPS recharged.
- Its `app` is stopped (§6).
- It is on the same tag as dev-server.
- §6's gap has been recovered on dev-server. If it has not, the cut-back's own safety dump on prod-server
  still holds it.

```sh
cd /srv/prod/pelicanpass
scripts/standby/cutback.sh
```

It confirms each step, in an order that loses nothing:

1. **Stop dev-server's app** (`STOP`). From here the public hostname answers with an error until
   step 4.
   - Optional: if the landing fallback runs on its own tunnel, route `SITE_HOST` to it first, so
     people see the countdown curtain instead of an error.
2. Snapshot dev-server.
3. Copy the snapshot to prod-server and run `restore.sh --reserve 0 --cutback` there, interactively
   (`RESTORE`). Writes were frozen before the snapshot, so no numbers need reserving. prod-server's
   previous database goes to its own `~/standby/pre-restore-<UTC>.dump`.
4. In the Cloudflare dashboard, move `SITE_HOST` from the standby tunnel back to production's
   tunnel ([`fallback.md`](./fallback.md) § 4). Nothing changes on either host. Confirm `/healthz`
   and one real pass, then type `DONE`.
5. The pull timer restarts. dev-server is a standby again, ready for a second failover.

If step 3 fails, `cutback.sh` stops there. Restart dev-server's app with `docker compose start app` and
leave `SITE_HOST` on dev-server.

**Skipping the cut-back.** On 18/10 the standby served for about 40 minutes while prod-server was offline
([event report](../reports/event-2026-10-17.md#the-1810-standby-episode)). The cut-back was skipped
on purpose: only one survey response had arrived on dev-server, and it was merged into the export by
hand. That is acceptable only when the standby took no writes that matter. Otherwise cut back, and
keep dev-server's database before deciding.

## 8. Rehearsal — before the event

Run both directions once, in a quiet window, against the real hosts:

1. Check in a test ticket and redeem an item on prod-server from a phone. Let a pull run.
2. Check in a second ticket and redeem an item on prod-server, after that pull and before the failover,
   so there is a gap.
3. Fail over (§5). The phone stays signed in and shows the first item collected. A new check-in on
   dev-server is numbered above `checkin_number_last + 500`.
4. Recover the gap (§6): `recover-gap.sh --dry-run`, then for real, then once more. The first two
   report the second ticket's check-in and redemption; the last reports 0 changes.
5. Check in and redeem once more on dev-server, then cut back (§7). prod-server holds both, and the phone is
   still signed in.
6. Time both directions from "decide" to "a pass loads". The cut-back time is the shortest quiet
   window worth using.

Reset the test tickets afterwards with the rehearsal reset in `deployment.md`.

## 9. Data retention and teardown

Every snapshot, cut-back tar and `pre-restore-*.dump` holds every attendee's phone number in
plaintext. They live in `~/standby` on **both** hosts, at mode `0600`. dev-server's root disk is
LUKS-encrypted. They are inventoried in [`data-retention.md`](../security/data-retention.md) and destroyed in
[`deployment.md` § Teardown](./deployment.md#teardown):

```sh
# dev-server
systemctl --user stop pelicanpass-standby-pull.timer
rm ~/.config/systemd/user/pelicanpass-standby-pull.{service,timer} && systemctl --user daemon-reload
rm -rf ~/standby
cd /srv/prod/pelicanpass && docker compose down -v

# prod-server
rm -rf ~/standby
# and remove the forced-command line from ~/.ssh/authorized_keys
```

Then delete the standby tunnel in Cloudflare and dev-server's standby node from the tailnet.
