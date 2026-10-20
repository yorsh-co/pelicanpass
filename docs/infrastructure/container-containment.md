# Container Containment

What to do on the host so that a compromised container cannot reach the host or the network it
sits on. Written for any machine that runs these stacks, and to be re-run from scratch on a new one.

Companion to
[`security-overview.md`](../security/security-overview.md#containers-and-host).

---

## 1. Goal

Assume an attacker has code execution in a container: a remote code execution bug in `app`, or a
poisoned image. `cloudflared`, `caddy` and `tailscale` carry the admin trust path and are pinned by
digest, but a pinned image can still be a bad one. From there they
must **not** reach:

- **The host's own services.** `sshd`, and anything else listening on one of the host's addresses.
- **The LAN.** The router's admin page, file shares, printers, the other machines.
- **Private overlays the host has joined.** A VPN, a tailnet.
- **Link-local addresses.** These include the cloud metadata endpoint `169.254.169.254`.

They **must** still reach:

- **The internet.** The tunnel dials Cloudflare, the app calls `challenges.cloudflare.com`,
  `<team>.cloudflareaccess.com` and `graph.facebook.com`.
- **The peers compose gives them.** `app`→`db`, `app`→`cache`, `tunnel`→`proxy`.

No published ports are involved. Every way in is an **outbound** connection from a container:

```
Internet ──▶ Cloudflare ──▶ (outbound tunnel) ──▶ tunnel ──▶ proxy :80   ──▶ app ──▶ db, cache
Admin    ──▶ tailnet    ──▶ (outbound)        ──▶ vpn    ──▶ proxy :8080 ──▶ app

app ──▶ internet                   allowed
app ─✕─ host, LAN, VPN, link-local  blocked by §3.4
app ─✕─ host via its bridge gateway  blocked by §3.6
```

The `vpn` sidecar exists in `compose.yml` and `compose.prod.yml`. The fallback has none: it is
`tunnel` → `app` alone.

So the host needs **no inbound rule for the app**. Containment is entirely about what leaves the
containers.

How you reach the host yourself is a separate decision, with one trap in it. See §7.

---

## 2. What a container reaches without containment

Confirm which daemon you are on **before** doing anything else:

```bash
docker info --format '{{.SecurityOptions}}'
# rootless  → contains  name=rootless
# rootful   → no rootless entry
```

|                          | Rootless daemon                                                                                 | Rootful daemon                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Container → internet     | NAT'd by RootlessKit, leaves as the **daemon user's own traffic**                               | Forwarded through the host from the bridge                                        |
| Container → LAN          | **Open.** It is host-origin traffic, and the host allows its own outbound traffic               | **Open.** Docker's `FORWARD` accepts are inserted ahead of a host firewall's      |
| Container → host         | **Open** on every host address. Delivered locally and accepted on `lo`, whatever UFW says       | Arrives on `INPUT` from the bridge. Any rule not scoped to an interface admits it |
| Container → host `127.*` | Blocked by RootlessKit's `--disable-host-loopback`, which `dockerd-rootless.sh` sets by default | Not reachable by default                                                          |
| An escape lands as       | The unprivileged user the daemon runs as                                                        | **Root**                                                                          |
| Where the filter goes    | `DOCKER-USER` inside RootlessKit's network namespace (§4)                                       | `DOCKER-USER` in the host's iptables (§5)                                         |

The rootless "open" rows are measured. They are why a host firewall cannot do this job here. Taken
on the reference host (native Linux, rootless, `slirp4netns`), with UFW enabled and both
`DEFAULT_INPUT_POLICY` and `DEFAULT_FORWARD_POLICY` set to `DROP`:

| From a container to                            | Without the filter | With the filter |
| ---------------------------------------------- | ------------------ | --------------- |
| Host's LAN address, `:22` (sshd on `0.0.0.0`)  | **reachable**      | blocked         |
| LAN router, `:80`                              | **reachable**      | blocked         |
| Tailnet address of the host                    | **reachable**      | blocked         |
| `10.0.2.2` (host loopback through the gateway) | blocked            | blocked         |
| `169.254.169.254:80`                           | blocked (no route) | blocked         |
| `1.1.1.1:443`                                  | reachable          | reachable       |

An earlier WSL2 measurement found the same thing, plus the Windows host's SMB port and the WSL DNS
stub. `FORWARD` never fired there, which rules out the forwarding path. RootlessKit NATs container
egress, so it reaches the kernel as the host's own traffic. Traffic to one of the host's own
addresses is delivered over `lo`, and `ufw-before-input` accepts `-i lo` unconditionally.

The filter's column also holds on a bare-metal production host running `gvisor-tap-vsock`, with UFW
active. With the filter on, the host's LAN `sshd`, the LAN router's `:80` (confirmed open from the
host), the uplink gateway `10.0.2.1` and `169.254.169.254` were blocked; the internet stayed
reachable.

**Consequence:** a host firewall is worth having for what arrives from the network. It is **not** the
control for what arrives from a container. §3.4 is.

---

## 3. Containment layers, strongest first

### 3.1 Rootless daemon

An escape from a container lands as an unprivileged user, not root. It also changes where the
egress filter has to live (§4). Use rootless unless something forces rootful.

### 3.2 Container hardening

Every service in `compose.prod.yml` runs with `read_only: true`, `cap_drop: ALL`,
`no-new-privileges`, a memory and process ceiling and a rotated container
log (`json-file`, 10 MB by 5 files; `app` keeps 20 files for its request log). Each of these
narrows what code execution inside the container can do next. `compose.fallback.yml` hardens `app`
alone. `compose.loadtest.yml` extends the production definitions, so it inherits them.

| Service   | User           | Capabilities added back                              | Writable besides volumes                    | Memory | PIDs |
| --------- | -------------- | ---------------------------------------------------- | ------------------------------------------- | ------ | ---- |
| `app`     | `node`         | none                                                 | `/tmp`                                      | 1 GB   | 128  |
| `proxy`   | `65532`        | `NET_BIND_SERVICE`                                   | `/data`, `/config` (tmpfs)                  | 256 MB | 256  |
| `cache`   | `redis`        | none                                                 | none (`cache` volume at `/data`)            | 512 MB | 128  |
| `db`      | root, then `postgres` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | `/tmp`, `/run/postgresql` (tmpfs)           | 4 GB   | 256  |
| `migrate` | `node`         | none                                                 | `/tmp`, `/home/node` (tmpfs)                | 512 MB | 128  |
| `tunnel`  | `65532`        | none                                                 | none                                        | 256 MB | 128  |
| `vpn`     | root           | none (userspace networking)                          | `/tmp`, `/var/run/tailscale` (tmpfs)        | 256 MB | 128  |

Why the exceptions:

- **`proxy`** binds `:80` and `:8080`. The Caddy binary carries `cap_net_bind_service` as a file
  capability, so with `no-new-privileges` it only starts if the capability is also in the container's
  bounding set; `cap_drop: ALL` alone fails with `exec /usr/bin/caddy: operation not permitted`. It
  runs as `65532`, not root. Nothing in `/data` or `/config` has to survive a restart: Cloudflare
  terminates TLS, so Caddy holds no certificate.
- **`db`** starts as root so its entrypoint can fix the ownership of the data directory and drop to
  `postgres`. Those five capabilities are that job and nothing else; the server itself runs with none.
- **`cache`** starts as `redis` directly, which skips the entrypoint's drop and needs no capability.
  Its password is passed as `--requirepass`, so it is visible to `docker inspect` and `docker compose
  config` (L5, accepted): anyone with Docker access on the host can already read `.env`, and a read-only
  root was preferred over moving it to a Compose secret, which Compose refuses on a `read_only` service.
- **`vpn`** needs no `NET_ADMIN`: `tailscaled` runs in userspace networking mode.
- **`migrate`** is `FROM build`, which has no `USER`; it runs as `node`, with a tmpfs home for npm's logs.

The ceilings are about six to ten times the peak seen with a 20-way check-in run against a scratch
stack (`proxy` 24 MB and 20 PIDs, `cache` 8 MB and 6 PIDs, `tunnel` 38 MB and 17 PIDs, `vpn`
23 MB and 34 PIDs), so a leak or a runaway child is stopped without touching normal traffic. `db` is
sized from its configuration instead, since `shared_buffers` alone is 2 GB and the host has 7 GB. Raise
a ceiling after a load test shows it is too low, not on a guess.

`app` is sized differently, from the raffle with load shedding on at `SCALE` 9, 16 and 20 (session
`2026-10-19T2007Z-prod-server-04fb5a3`, `prod-server`): peak 401 MiB and 15 PIDs, idle about 110 MiB. `1g` is about
twice the peak. Under it V8's heap limit is 560 MiB (2,240 MiB unlimited, sized from host RAM), which leaves
45% for everything else, so no `--max-old-space-size`. `128` PIDs rather than four times the peak: each
`docker compose exec app node …` CLI adds about 11 threads.

`scripts/compose/hardening.test.ts` fails if a service loses any of these flags or gains a capability
that is not listed there, or its container log loses its rotation.

**Accepted: the `logs` volume is writable and executable.** `/var/log/pelicanpass` is the one path
`app` can write that is not `noexec`. Docker cannot mount a named volume `noexec`, `nosuid` and
`nodev` while keeping it a plain named volume (no host path) that survives a recreate; tried on a
rootless daemon with the `local` driver:

| Volume definition                                          | Result                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `type: none`, `o: bind,noexec,nosuid,nodev`, a host `device` | The flags are ignored on a bind mount: a copied `busybox` runs. Also needs a host path |
| `type: tmpfs`, `o: noexec,nosuid,nodev`                      | A copied binary is refused (`Permission denied`), but the contents are gone once the container stops, which defeats a log that must outlive a recreate |
| Long-syntax `volumes:` entry                               | Has no mount-option field for a named volume                                       |

It is accepted because what it allows is already allowed. The attacker must first be running code as
`node`, and `node` is an interpreter that executes whatever it is given; a native binary adds little.
The root filesystem is read-only, `/tmp` and `/dev/shm` are `noexec`, the process holds no capability and
cannot gain one, and `/usr/src/app` is root-owned, so the file cannot overwrite the code the next start
loads. The volume is also inventoried in `data-retention.md` and removed with `down -v`. Revisit it if
the logs move to the `json-file` driver alone, or to a bind mount on a host path that the operator mounts
`noexec`.

**Accepted (N-A34-3): the `cache` and `db` data volumes are writable and executable**, beside the `logs`
volume and for the same reason. Docker cannot mount a persistent named volume `noexec`, and a tmpfs
would lose the data on a restart. `/data` in `cache` and `/var/lib/postgresql/data` in `db` take a
copied binary that runs (as `redis` and `postgres` respectively). What it allows is already allowed:
the attacker must first be running code as that service's own non-root user, which holds no
capability (`db` keeps its five only in the bounding set, and has dropped to `postgres` before it
serves), cannot gain one, and sits on a read-only root with `noexec` `/tmp`. Nothing but the service's
own uid can write the volume, and neither service has a route to the internet. Revisit it together
with the `logs` volume.

No production service loads `.env` whole. Each names the variables it reads under `environment:`,
so code execution in `app` finds no database superuser, migrator, tunnel or Tailscale credential
in its environment. `scripts/compose/env-scope.test.ts` fails if that changes.

None of this restricts the network. It is a different layer, not a substitute for §3.4.

### 3.3 Network segmentation

Enforced inside the daemon's namespace by Docker itself. It survives restarts and cannot drift.

- **`edge`, `web` and `data` are `internal: true`** in production. A container on them alone has no
  route off its bridge: not to the LAN, not to the internet. `db` and `cache` sit on `data` only.
  `proxy` bridges `edge` and `web`, so a compromised proxy cannot call out. In the load-test and
  development stacks only `data` is internal.
- **`egress` and `app-egress` are the only networks with a gateway**, and only the services that dial
  out join them: `tunnel` (Cloudflare) and `vpn` (the Tailscale control plane and relays) join
  `egress`; `app` (`challenges.cloudflare.com`, `<team>.cloudflareaccess.com`,
  `graph.facebook.com`) joins `app-egress`, alone.
- **`app` shares no network with `tunnel` or `vpn`.** The Access gate trusts `X-Admin-Gate` because
  only `proxy` (on `web`) and the data peers (on `data`) can reach `app:3000`; on a shared network a
  compromised connector could forge the header and skip the Cloudflare Access check.
  `scripts/compose/network-egress.test.ts` fails if another service joins a network `app` is on.
- **`tunnel` reaches `proxy` and nothing behind it** on `edge`, so a stolen tunnel token cannot be
  turned on the database or on `app`. Check 5 in §6 proves it. The `vpn` pin (`VPN_IP`) is on `edge`,
  where the Caddyfile's `remote_ip` gate reads it.
- **Dropping `app` from `app-egress` breaks captcha verification and locks every administrator out of
  the public path.**

§3.4 is still needed: `tunnel`, `vpn` and `app` have a route out, and through it to everything in §2.
On the fallback's default network every container does.

### 3.4 The egress filter

`scripts/container-egress-filter.sh` drops traffic **leaving through the daemon's uplink** towards:

| Range                                           | Covers                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | Any RFC1918 LAN, and the host's address on it       |
| `169.254.0.0/16`                                | Link-local, including cloud metadata                |
| `100.64.0.0/10`                                 | CGNAT, which is where Tailscale addresses come from |
| `fd00::/8`, `fe80::/10`                         | IPv6 ULA and link-local                             |

Before the drops, one `RETURN` lets through the uplink's own subnet (`10.0.2.0/24` under both
`slirp4netns` and `gvisor-tap-vsock`), which carries the gateway and the resolver. That exception is
only safe while nothing in the subnet leads back to the host's loopback, which §4.1 checks.

Four details make or break it:

- **It matches on the uplink (`-o`), not on bridges.** `data` and `edge` are inside `172.16.0.0/12`,
  so an unscoped drop would cut `app`→`db`, `app`→`cache` and `tunnel`→`proxy`. Bridge-to-bridge
  traffic never touches the uplink.
- **One filter covers every stack on the daemon.** Production, fallback and load test all leave
  through the same uplink.
- **Public destinations need no rule.** Only private and link-local ranges are dropped.
- **IPv6 is covered for ULA and link-local only.** None of the compose networks sets
  `enable_ipv6`, so containers get no IPv6 address unless the daemon's own configuration turns it
  on. If it does, on a LAN with a global IPv6 prefix, that prefix needs its own drop.

### 3.5 No published ports

Nothing in any compose file has a `ports:` mapping, and it must stay that way. On a rootful daemon a
published port **bypasses** the host firewall, because Docker's `nat` rules come before it. On
rootless it is bound by the daemon user on every interface. Either way it opens a path in that this
document does not account for.

### 3.6 The bridge gateway

§3.4 filters **forwarded** traffic: a packet that leaves through the uplink passes `DOCKER-USER`.
A container's connection to **its own bridge gateway** (`172.x.0.1`, the daemon's address on that
bridge) is not forwarded. It is delivered locally, so it arrives on `INPUT` and `DOCKER-USER` never
sees it. Whatever listens on the namespace that owns the bridge, on all addresses (`0.0.0.0` or
`::`), answers a container.

- **Rootful:** that namespace is the host's. `sshd`, a database or any other service bound to every
  address is reachable at the gateway address, whatever the egress filter says.
- **Rootless:** it is the daemon's own namespace (§4.1), which holds no host services. What can
  listen there is what the daemon itself binds, so the exposure is small today; it grows if a
  `ports:` mapping with a non-loopback bind is ever added (§3.5).

On the reference host nothing in the daemon's namespace listened on a bridge address, and a
connection to a gateway answered "refused". That is safe by absence, not by rule. §4.4 and §5 add
the rule: new connections from the Docker bridges to the host's own addresses are dropped.

**What stays allowed.** Nothing the stacks use arrives on `INPUT` from a bridge:

- **DNS.** Compose networks are user-defined, so containers resolve through Docker's embedded
  resolver at `127.0.0.11`, which lives in the container's own namespace. Its upstream queries leave
  from the daemon (`OUTPUT`, then the uplink), not through `INPUT`.
- **Peers.** `app`→`db`, `app`→`cache` and `tunnel`→`proxy` are bridge-to-bridge or intra-bridge,
  which is `FORWARD`.
- **Replies.** The rule matches `NEW` connections only, so answers to anything the host or daemon
  started are untouched.

If you add a service that a container must reach on the host (a `host.docker.internal` or gateway
address in a compose file), allow that one port from that bridge ahead of the drop. None of the
compose files here does.

---

## 4. Install the filter: rootless host

Run everything here **as the user the daemon runs as**. Nothing needs sudo except enabling linger.

### 4.1 Preflight

The script assumes `iptables`, a detached network namespace, and an uplink called `tap0` on
`10.0.2.0/24`. Check all three before installing:

```bash
docker info | grep -i "Firewall Backend"
# iptables. Under nftables there is no DOCKER-USER chain and the script times out.

ps -ww -o args= -C rootlesskit
# expect --detach-netns and --disable-host-loopback; --net= names the driver

S=/run/user/$(id -u)/dockerd-rootless
nsenter --preserve-credentials -U -m -t "$(cat "$S/child_pid")" \
  nsenter --net="$S/netns" ip route
# default via 10.0.2.2 dev tap0       (10.0.2.1 under gvisor-tap-vsock)
# 10.0.2.0/24 dev tap0 ... src 10.0.2.100
```

`dockerd-rootless.sh` picks `slirp4netns` when it is installed, and falls back to `pasta`, then
`gvisor-tap-vsock`. Both `slirp4netns` and `gvisor-tap-vsock` give the result above, differing only
in the gateway. Record the gateway for check 4 in §6. If the default route names a different device
or subnet, record both. §4.2 passes them to the script.

Then confirm the subnet the filter lets through does not lead back to the host. Run this with `sshd`
listening on `0.0.0.0`, which makes it answer on loopback too:

```bash
docker run --rm alpine sh -c '
  for i in $(seq 1 254); do
    nc -zw1 10.0.2.$i 22 2>/dev/null && echo "OPEN 10.0.2.$i:22"
  done; echo done'
# → done, and nothing else
```

Measured clean under both `slirp4netns` and `gvisor-tap-vsock`. Any `OPEN` means that address maps to
the host's loopback, and every loopback-only service on the host is reachable through the filter's
exception. Do not install until `UPLINK_SUBNET` is narrowed to exclude it.

The `nsenter` takes two hops on purpose. RootlessKit's `--detach-netns` leaves `dockerd` in the host
namespace and puts the bridges in a detached one, bind-mounted at `$S/netns`. That mount is only
visible inside RootlessKit's mount namespace, so the command joins the user and mount namespaces
through `child_pid` first, then the network namespace from inside. The single-hop forms fail:
`-n -t <child_pid>` with `Operation not permitted`, and `--net=$S/netns` from the host with
`Invalid argument`.

### 4.2 Install

```bash
install -Dm 0755 scripts/container-egress-filter.sh ~/.local/bin/container-egress-filter.sh
install -Dm 0644 scripts/container-egress-filter.service \
  ~/.config/systemd/user/container-egress-filter.service
```

Only if §4.1 found an uplink other than `tap0` on `10.0.2.0/24`:

```bash
mkdir -p ~/.config/systemd/user/container-egress-filter.service.d
cat > ~/.config/systemd/user/container-egress-filter.service.d/uplink.conf <<'EOF'
[Service]
Environment=UPLINK=<device> UPLINK_SUBNET=<cidr>
EOF
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now container-egress-filter.service
~/.local/bin/container-egress-filter.sh status       # one RETURN and five DROPs on the uplink

loginctl show-user "$(id -un)" -p Linger
# Linger=no → sudo loginctl enable-linger "$(id -un)"
```

**The rules die with the daemon.** They live in its namespace, so without the unit the filter lasts
until the first `systemctl --user restart docker` and then silently stops existing.
`PartOf=docker.service` is what rebuilds it, and linger is what starts both at boot.

### 4.3 Prove it comes back

Reading the chain does not prove it will be populated again. Flush it and restart the daemon:

```bash
~/.local/bin/container-egress-filter.sh flush
systemctl --user restart docker && sleep 10
~/.local/bin/container-egress-filter.sh status       # rules back
```

**Restarting the daemon stops every stack on it**, production included. Do this before the event.
Containers with `restart: unless-stopped` come back on their own; for the others, run
`docker compose up -d` in each stack. Expect Caddy to answer 503 for a few seconds while its
`health_uri` settles.

A host that predates this filter may carry an older recipe: `OUTPUT` rules with
`-m owner --uid-owner <daemon user>` on the host, for a dedicated daemon account. The filter
replaces them, filtering before the traffic is NAT'd instead of after.

### 4.4 Drop new connections to the bridge gateways

`container-egress-filter.sh apply` also installs this, in the same namespace: on `INPUT`, scoped to
the bridges (`br-*` for compose networks, `docker0` for the default one), it drops new connections
(§3.6). `flush` removes them again, and the systemd unit re-applies them with the rest whenever the
daemon starts. Check it:

```bash
~/.local/bin/container-egress-filter.sh status
# --- IPv4 INPUT ---  two DROP rules, -i docker0 and -i br-+, matching conntrack NEW
```

Then run check 7 in §6. An already-installed copy of the script predates this: re-run the `install`
from §4.2 and `systemctl --user restart container-egress-filter.service`.

---

## 5. Rootful hosts

**Nothing in this section has been measured.** Every host this project has run on is rootless. Use
rootless (§3.1) if you can. If you cannot, this is the starting point, and the §6 checks are what
decides whether it works.

- **LAN and host.** Container traffic to both is forwarded from a bridge, so it passes Docker's
  `DOCKER-USER` chain in the host's iptables. Mirror the rootless filter there, scoped to the
  host's uplink NIC (`ip -brief link`):

  ```bash
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    sudo iptables -I DOCKER-USER -o <nic> -d "$net" -j DROP
  done
  ```

- **The host's own addresses.** That traffic is delivered, not forwarded, so it arrives on `INPUT`
  from the bridge and `DOCKER-USER` never sees it (§3.6). Any rule that is not scoped to an
  interface, such as `ufw allow 22`, also admits every container. Drop new connections from the
  bridges, ahead of the host firewall's own rules. Matching the bridges by interface covers every
  Docker subnet, including ones the daemon picks or a compose file pins (`EDGE_SUBNET`):

  ```bash
  # iptables (and ip6tables, the same two lines)
  for br in br-+ docker0; do
    sudo iptables -I INPUT 1 -i "$br" -m conntrack --ctstate NEW -j DROP
  done
  ```

  ```bash
  # nftables: its own table, hooked before the host firewall's chains (priority 0)
  sudo nft -f - <<'EOF'
  table inet container_input {
    chain input {
      type filter hook input priority -10; policy accept;
      iifname { "docker0", "br-*" } ct state new drop
    }
  }
  EOF
  ```

  Keep either one only after check 7 in §6 passes. Persist the iptables form as below, and the
  nftables form by saving the table into the file `nftables.service` loads.
- **Persistence.** These rules are not saved by UFW. Use `netfilter-persistent save`, or a unit
  ordered `After=docker.service`. `DOCKER-USER` is created by `dockerd`, so anything that runs
  earlier finds no chain.
- **nftables.** If `docker info` reports `Firewall Backend: nftables`, these chains are not where
  this section says. Find the equivalent with `nft list ruleset` before writing anything.

---

## 6. Verification

Do not trust the ruleset; run the checks. Earlier versions of three of these did not work at all,
and a check that silently does nothing reads as an assurance.

Set the variables for the stack under test. The project name comes from `name:` in its compose file:

| Stack      | `PROJECT`                   | `NET`                               | Checks |
| ---------- | --------------------------- | ----------------------------------- | ------ |
| Production | `pelicanpass-prod`     | `pelicanpass-prod_web`         | 1–7    |
| Fallback   | `pelicanpass-fallback` | `pelicanpass-fallback_default` | 1–4, 7 |
| Load test  | `pelicanpass-loadtest` | `pelicanpass-loadtest_web`     | 1–4, 6–7 |

Replace the `<…>` placeholders. Pasted unfilled, they fail rather than test the wrong stack:

```bash
PROJECT=<PROJECT from the table>
NET=<NET from the table>
IMAGE=${PROJECT}-app
UPLINK_GW=<the uplink gateway from §4.1>

# The LAN router and the host's address on that LAN, read from the host itself
GATEWAY=$(ip route show default | awk '{print $3; exit}')
HOST_IP=$(ip -4 route get "$GATEWAY" | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')
echo "project $PROJECT  host $HOST_IP  gateway $GATEWAY  uplink $UPLINK_GW"
```

Run each check from that stack's checkout:

```bash
# 1. The filter is in place (rootless). One RETURN and five DROPs, all on the uplink.
~/.local/bin/container-egress-filter.sh status
systemctl --user is-active container-egress-filter.service      # active

# 2. Nothing published. A correct host still shows 80/tcp, 5432/tcp or 6379/tcp:
#    those are exposed, not published. The test is the absence of a `->` mapping.
docker compose ps --format '{{.Names}} {{.Ports}}' | grep -- '->' \
  && echo 'PUBLISHED PORT FOUND' || echo 'nothing published'

# 3. Containers can still reach the internet.
docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e \
  "fetch('https://challenges.cloudflare.com').then(r=>console.log('egress ok',r.status))"
#    → egress ok 200

# 4. Containers cannot reach the host, the LAN, an overlay or link-local.
#    Add a port that is really open on each target, or "blocked" proves nothing,
#    and add a VPN or tailnet peer if the host has joined one.
for t in "$HOST_IP 22" "$GATEWAY 80" "$UPLINK_GW 22" "169.254.169.254 80"; do
  docker run --rm --network "$NET" --entrypoint sh "$IMAGE" \
    -c "nc -zvw2 $t >/dev/null 2>&1 && echo 'REACHABLE $t' || echo 'blocked   $t'"
done
#    → blocked, every one

# 5. The connectors' networks cannot reach the data tier or app (production). A throwaway
#    container on `edge` alone stands where cloudflared does; the cloudflared
#    image has no shell to exec into.
docker run --rm --network "${PROJECT}_edge" --entrypoint sh "$IMAGE" \
  -c 'nc -zvw2 db 5432; nc -zvw2 cache 6379'
#    → nc: bad address 'db' / nc: bad address 'cache'
#    Failing at name resolution is stronger than a refused connection: Docker's
#    embedded DNS is per-network, so those names do not exist there at all.
#    The same holds for `app` from `egress`, where `vpn` also sits:
docker run --rm --network "${PROJECT}_egress" --entrypoint sh "$IMAGE" \
  -c 'nc -zvw2 app 3000'
#    → nc: bad address 'app'

# 6. The app can still reach them (production, load test).
docker compose exec app sh -c 'nc -zvw2 db 5432 && nc -zvw2 cache 6379'
#    → both open

# 7. Containers cannot connect to their own bridge gateway (§3.6). Port 22 need not be
#    open: without the INPUT rule a closed port answers "refused" at once, with it
#    the connection is dropped and times out. Each network of the stack, each gateway.
for net in $(docker network ls --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Name}}'); do
  gw=$(docker network inspect "$net" --format '{{(index .IPAM.Config 0).Gateway}}')
  printf '%s %s: ' "$net" "$gw"
  docker run --rm --network "$net" --entrypoint sh "$IMAGE" \
    -c "nc -zvw2 $gw 22 2>&1 | tail -n 1"
done
#    → timed out, every one. "Connection refused" or "open" means the rule is missing.
```

Check 4 is only meaningful when the target answers from the host itself, so pick ports you know are
open (`ss -tlnp` on the host, the router's admin page). `UPLINK_GW` must stay blocked even though
the filter lets its subnet through: what stops it is RootlessKit's `--disable-host-loopback`, not
the filter.

Check 7 starts a container on each network, which stands where `app` does on `web` and `data`. A
gateway that answers "refused" is reachable: the host process or the kernel answered it.

Check 6 is the regression test for the uplink scoping in §3.4. `data` is inside a range the filter
drops, so a failure here means the `-o` was lost.

Then **reboot and run all of them again**. `wsl --shutdown` from Windows on WSL2 (§8). Rules that do
not survive a reboot are the failure this step exists to catch.

---

## 7. Host access is yours

This project needs nothing from the host's inbound firewall: no published port, no inbound rule. How
administrators reach the machine (SSH on the LAN, over a VPN or tailnet, or through a Cloudflare
tunnel to `localhost:22`) belongs to the host, and any of them is fine.

Whichever you choose:

- **Do not count it as containment.** On a rootless host every service listening on a host address,
  including `sshd` on `0.0.0.0`, is reachable from a container until §4 is in place. That holds
  however tightly the firewall scopes the service to an interface or a subnet (§2).
- **Scope it to where it comes from anyway.** For example, `ufw allow from <lan>/24 to any port 22`
  or `ufw allow in on tailscale0 …`, rather than a bare `ufw allow 22`. The firewall still governs
  what arrives from the network.
- **Change it with a second session open**, and confirm the new path works before closing the first.

---

## 8. WSL2 hosts

**UFW inside WSL governs the WSL VM only.** Windows has its own network stack and firewall, and
neither is visible from inside. A `netsh interface portproxy` entry on the Windows side republishes
a WSL port to the LAN without touching anything in this repo or in UFW. Audit it separately:

```powershell
netsh interface portproxy show all     # expect no entries
Get-NetFirewallRule -Enabled True | Where-Object Direction -eq Inbound
```

**NAT vs mirrored networking changes exposure completely.** Under the default NAT mode, WSL sits
behind a Hyper-V vSwitch on a private subnet, so a `0.0.0.0` bind is not LAN-reachable. Under
`networkingMode=mirrored` in `.wslconfig` it shares the Windows interfaces, and the same bind **is**.
Record which one:

```bash
ip -brief addr    # NAT: eth0 on a 172.x/20 plus a 10.255.255.254/32 stub on lo
```

**The Windows host is on the LAN side of the filter.** Its address (`172.x.x.1` under NAT) is inside
`172.16.0.0/12`, and the WSL DNS stub (`10.255.255.254`) is inside `10.0.0.0/8`, so both are
dropped. Add them to check 4.

**"Reboot" means `wsl --shutdown` from Windows.** `sudo reboot` inside the distro is not the same
test. Persistence needs `systemd=true` in `/etc/wsl.conf`, so that linger starts the user units.

---

## 9. New-machine checklist

- [ ] `docker info --format '{{.SecurityOptions}}'`: record rootless or rootful
- [ ] `docker info | grep -i "Firewall Backend"`: record iptables or nftables
- [ ] Rootless: run the §4.1 preflight, including the subnet scan; record the uplink device, subnet and gateway
- [ ] Rootless: install and enable the filter (§4.2), confirm `Linger=yes`
- [ ] Rootless: flush, restart the daemon and confirm the rules return (§4.3)
- [ ] Rootless: confirm the `INPUT` drops for the bridges are listed by `status` (§4.4)
- [ ] Rootful: apply §5, including the `INPUT` drop for the bridges, persist it, and treat the §6 results as the only evidence
- [ ] `internal: true` on `data` in the deployed compose file
- [ ] No `ports:` entries in any deployed compose file
- [ ] WSL2 only: NAT or mirrored recorded, `portproxy` empty, `systemd=true` (§8)
- [ ] §6 checks for every stack on the host
- [ ] Reboot, then the §6 checks again
- [ ] Tunnel tokens in a `0600` env file or a Docker secret, not a world-readable `.env`

---

## What this does not cover

- **Inbound filtering.** Everything public arrives through Cloudflare; rate limiting and Access live
  there. See [`cloudflare-rules.md`](./cloudflare-rules.md).
- **The host's own access.** SSH configuration, VPNs and the host firewall's inbound rules (§7).
- **The `vpn` sidecar's reach into the tailnet.** It is a tailnet node itself, and its traffic to
  peers is tunnelled through a public endpoint the filter allows. What it can reach is set by the
  tailnet's ACLs, not by this filter.
- **Kernel escapes.** Rootless limits where one lands (§3.1); it does not prevent one.
- **The Windows host** of a WSL2 machine, beyond the checks in §8.
- **Host intrusion detection.** Out of scope for a single-event deployment.
