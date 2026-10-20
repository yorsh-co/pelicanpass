# Event-Day Support

A Claude Code session on dev-server that answers operator questions during the event from this
repository's documentation. The operator pastes stripped log excerpts and errors; the session
points to the runbook section and the next command. It complements, and never replaces, the
runbooks it cites.

---

## 1. What this is

|                  | Support session                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| Runs on          | dev-server, in `/srv/prod/pelicanpass-support` (a checkout of this repo)     |
| Can              | Read and search this repo with its own tools, run read-only `git`        |
| Cannot           | Edit files, read the standby checkout or any `.env`, run Docker, `psql`, `ssh`, `curl`, shell file readers or the standby and db scripts |
| Sees production? | No. Only what the operator pastes                                        |

The session never touches prod-server. Every command it suggests is for the operator to run, with the
host named. "No edits, no host access" is enforced by [`support/settings.json`](../support/settings.json):
deny rules win over allow rules and over the operator's own settings files. dev-server also holds the
standby stack and its `.env` in `/srv/prod/pelicanpass`, so file access goes through the session's
Read and Grep tools, which the deny rules cover, and the shell readers (`cat`, `grep`, `jq`, …)
are denied outright.

The session's brief is [`support/index.md`](../support/index.md): hard rules, stack facts, log
recipes, a symptom table and the warm-up reading list. It is loaded with
`--append-system-prompt-file` and a `--settings` flag, not through a root `CLAUDE.md` or a committed
`.claude/settings.json`, because either would apply to every development session in the repo.

| File                                                       | Role                                           |
| ---------------------------------------------------------- | ---------------------------------------------- |
| [`support/index.md`](../support/index.md)                   | The session's system prompt                    |
| [`support/settings.json`](../support/settings.json)         | Read-only permissions                          |
| [`../scripts/support/strip-log.sh`](../../scripts/support/strip-log.sh) | Removes identifiers before a paste   |

---

## 2. Before the event

- [ ] **Data controller sign-off.** Pasted logs leave the host and reach Anthropic, a processor in
      the US: an international transfer. Stripping reduces the exposure but does
      not remove the need for the data controller's agreement (roles in
      [`incident-response.md`](../security/incident-response.md)). Send the paragraph below and keep the reply.
- [ ] **Claude account data settings.** Check whether chats may be used for model training and what
      retention applies, and set both to what the controller accepted. Do not rely on remembered
      defaults.
- [ ] **Install the stripper on prod-server** without moving the deployed checkout. From this checkout:

  ```bash
  ssh prod-server 'mkdir -p ~/bin'
  scp scripts/support/strip-log.sh prod-server:~/bin/
  ssh prod-server 'chmod +x ~/bin/strip-log.sh && jq --version'   # jq 1.6 or later
  echo '{"ip":"203.0.113.7","msg":"x"}' | ssh prod-server '~/bin/strip-log.sh'
  # expect: {"ip":"[stripped]","msg":"x"}
  ```

- [ ] **Match the checkout to production.** The session cannot see prod-server, so a stale checkout gives
      confident wrong answers.

  ```bash
  git -C /srv/prod/pelicanpass-support describe --tags --always   # dev-server
  curl -s https://<tailnet-name>/readyz | jq .release             # tailnet only
  ```

  If they differ, `git fetch --tags` and check out the deployed tag here.

- [ ] **Rehearse** (§ 6).

Paste-ready paragraph for the controller:

> Durante o evento de 17/10/2026, o operador usará um assistente de IA (Claude, da Anthropic, EUA)
> para diagnosticar falhas, enviando trechos de logs do sistema de check-in. Antes de qualquer cópia,
> um script testado, executado no próprio servidor, remove IPs, e-mails, telefones, códigos de
> ingresso, identificadores e agentes de usuário; ainda podem restar nomes digitados em texto livre
> e códigos de ingresso do sistema de inscrição em texto livre. O objetivo é restabelecer o serviço mais
> rápido, e o envio constitui transferência internacional de dados (política de privacidade, itens
> 9 e 12). Os trechos enviados são processados pela Anthropic conforme os termos e as
> configurações da conta utilizada; as transcrições guardadas no servidor do operador serão
> apagadas no encerramento do evento. Solicitamos sua concordância.

---

## 3. Starting the session

On dev-server:

```bash
cd /srv/prod/pelicanpass-support
claude --settings docs/support/settings.json --append-system-prompt-file docs/support/index.md
```

Then run `/fast` and paste the warm-up prompt:

```text
Read, in order, every item in the Warm-up list of your support index. Reply "ready" and nothing else.
```

Warm-up reads about 22k tokens; wait for "ready" before the first paste.

---

## 4. Pasting

Everything pasted goes through `strip-log.sh` on prod-server, in the checkout. The recipes are in the
index (Log recipes). The three most used:

```bash
# Errors and crashes, last 10 minutes
docker compose logs --since 10m --no-log-prefix app | jq -cR 'fromjson? | select(.level >= 50) | {time, msg, code, path, id: .req.id}' | ~/bin/strip-log.sh
# Durable log, survives a recreate
docker compose exec -T app sh -c 'cat /var/log/pelicanpass/app.*.log' | jq -cR 'fromjson? | select(.level >= 50)' | ~/bin/strip-log.sh
# One request
docker compose logs --no-log-prefix app | jq -cR --arg id '<request-id>' 'fromjson? | select(.req.id == $id)' | ~/bin/strip-log.sh
```

Paste template:

```text
When:      <time, timezone>
Host:      prod-server | dev-server
Doing:     <what the attendee or operator was doing>
Where:     <URL or screen>
Excerpt:   <stripped output>
Tried:     <what was already tried>
```

Screenshots: crop or blur names, phone numbers and codes first. If the session flags an identifier,
do not resend it; tell the controller if it was a real one.

**The script cannot remove:**

- Personal names in free text.
- Ticket codes in free text: the script masks them only under identifying keys such as `ticketCode`, because six alphanumerics are indistinguishable from ordinary words.
- Short digit ids in free text.

**It over-masks**, so a missing value is not always a bug:

- Any run of 10 to 13 digits (timestamps, byte counts).
- Internal container IPs.

---

## 5. Keeping it fast

- One session, support only. No development in it.
- `/compact` in a lull, never mid-incident.
- If answers drift or get slow, `/clear` and run the warm-up again.
- After a hotfix on prod-server: `git fetch --tags`, check out the new tag here, then tell the session
  what changed.

---

## 6. Rehearsal

Before the event, start the session as in § 3 and paste five incidents taken from the index's
symptom table and the alerts. Time each answer. A row that exists in the index should be answered
in under 10 s. Where an answer was slow or wrong, fix `support/index.md` and rerun that case.

Generate log lines on the development stack (`compose.yml`), never on the standby project.

Prove the deny rules in the same session: ask it to read `/srv/prod/pelicanpass/.env`, to run
`docker ps` and to run `bash scripts/standby/pull.sh`. All three must be refused without a
permission prompt; `/permissions` lists the rules in force.

---

## 7. After the event

Transcripts hold the pasted excerpts. On dev-server, delete them as part of the teardown in
[`data-retention.md`](../security/data-retention.md#teardown--the-one-procedure-that-matters):

```bash
rm -r ~/.claude/projects/-srv-prod-pelicanpass-support/
```

Remove `~/bin/strip-log.sh` from prod-server if it is no longer needed.
