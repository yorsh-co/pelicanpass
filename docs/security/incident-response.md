# Incident Response

What to do when something goes wrong in a running deployment: a suspected breach, leaked secret,
data exposure or a compromised host. Written for whoever operates the deployment; it names roles,
not people.

This codebase is provided as is (see the [Disclaimer](../../README.md#disclaimer)). The operator of a
deployment owns its incidents; this runbook is a starting point, not a guarantee of adequacy.

| Role            | Responsibility                                                            |
| --------------- | ------------------------------------------------------------------------- |
| Operator        | Runs the host and the stack; executes every step below                    |
| Data controller | The organisation the attendee data is held for; decides on notification   |
| DPO             | The controller's data protection officer, where one exists; advises on it |

Fill in who holds each role, and how to reach them out of hours, **before** the event.

---

## 1. Triage

Answer three questions, and write the answers down with the time:

1. **What was observed?** An alert, a report, a log line, a screenshot. Keep the original.
2. **Is it still happening?** An active attacker or an ongoing leak goes straight to §2.
3. **Could personal data be involved?** Attendee names, phone numbers, IP addresses in logs. If yes,
   or if you cannot rule it out, tell the data controller now, not after the investigation.

| Severity | Example                                                        | Response                        |
| -------- | -------------------------------------------------------------- | ------------------------------- |
| Critical | Personal data exposed or exfiltrated; host or database access  | Contain immediately; notify now |
| High     | A secret leaked; an auth bypass exploitable but not yet abused | Contain within the hour         |
| Medium   | A vulnerability reported with no evidence of use               | Fix before the next event       |

Every command below assumes the production `.env` sets `COMPOSE_FILE=compose.prod.yml`
([`deployment.md` § Which compose file runs](../operations/deployment.md#which-compose-file-runs)).

## 2. Contain

Pick the smallest step that stops the harm.

```bash
# Cut public ingress. The tailnet path (vpn → proxy) stays up for operators.
docker compose stop tunnel

# Cut the tailnet path too.
docker compose stop vpn

# Stop everything, keeping every volume. Never `down -v` during an incident: it destroys the evidence.
docker compose stop
```

**Rotate what leaked.** Every secret lives in `.env`; after changing one,
`docker compose up -d --force-recreate <service>`. Two have side effects:

- `ADMIN_PASSWORD_PEPPER`: rotating it locks out every administrator until each password is set
  again with `scripts/admin/set-admin-password.ts`.
- `PASS_SECRET`: rotating it invalidates every issued attendee pass.

Tokens issued by third parties (`TUNNEL_TOKEN`, `TS_AUTHKEY`, `WHATSAPP_*`, `TURNSTILE_*`) must also
be revoked at the provider, not only replaced locally.

**If a release is at fault**, roll back per [`deployment.md` § Rollback](../operations/deployment.md#rollback).
Alert and metrics guidance is in [`deployment.md` § Operations](../operations/deployment.md#operations).

## 3. Preserve evidence

Do this **before** any teardown. `docker compose down -v` destroys the durable log file, container
logs and `app_events` ([`data-retention.md`](./data-retention.md)).

```bash
set -a; . ./.env; set +a
mkdir -p incident-$(date +%F) && cd incident-$(date +%F)
docker compose logs --no-color --timestamps > containers.log
docker compose cp app:/var/log/pelicanpass ./logs-archive
docker compose exec -T db pg_dump -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -t app_events > app-events.sql
```

These files hold IP addresses and actor ids, and are personal data. Keep only what the investigation
needs, record where each copy is, and delete them on the same schedule as the attendee data unless a
legal obligation says otherwise. Take a full `pg_dump` only if the investigation needs one.

## 4. Notify

The data controller decides whether and whom to notify; the operator supplies the facts. Regulatory
deadlines are short and run from when the incident becomes known, for example:

- **GDPR:** the supervisory authority within 72 hours (Art. 33).
- **LGPD (Brazil):** the ANPD and affected data subjects within the period set by current ANPD
  regulation (three business days at the time of writing).

Check the law that applies to your deployment; these examples are not legal advice. Notify affected
people when the law or the controller requires it, in plain language: what happened, what data, what
they should do.

## 5. Recover

1. Fix the cause and release it as a new tag, or roll back to a known-good one.
2. Rebuild from that tag on a clean host if the host itself may be compromised.
3. Re-run the acceptance checks in [`deployment.md` § Verification](../operations/deployment.md#verification)
   before reopening public ingress with `docker compose start tunnel`.

## 6. Review

Within a week, write a short record and keep it with the project's private notes:

```markdown
## Incident <date>: <title>

- **Timeline:** detected, contained, notified, resolved (with times)
- **Cause:**
- **Data affected:** categories, approximate number of people
- **Notifications made:** to whom, when
- **Actions:** what changes, owner, due date
```

When the event is over, finish with the normal [teardown](../operations/deployment.md#teardown), including
deleting any evidence files that are no longer required.
