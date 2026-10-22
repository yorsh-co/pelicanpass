# Guia do revisor (pt-BR)

Ponto de entrada para quem revisa este repositório com foco em **infraestrutura** e
**segurança**. É um mapa, não uma tradução: diz onde cada coisa mora, o que verificar e qual
documento em inglês tem o raciocínio completo.

**Os documentos de origem estão em inglês e prevalecem.** Se este guia divergir deles ou do
código, o código é a verdade, depois o documento de origem, e este guia está desatualizado —
abra uma issue ou corrija-o no mesmo PR.

Identificadores, caminhos, comandos e termos técnicos consagrados (`middleware`, `rate limiting`,
`tailnet`) ficam em inglês. Há um [glossário](#9-glossário-en--pt) no final.

## Sumário

1. [O sistema em 5 minutos](#1-o-sistema-em-5-minutos)
2. [Mapa do repositório](#2-mapa-do-repositório)
3. [Por onde começar](#3-por-onde-começar)
4. [Infraestrutura](#4-infraestrutura)
5. [Segurança](#5-segurança)
6. [Não "corrija" isto](#6-não-corrija-isto)
7. [Checklist de revisão](#7-checklist-de-revisão)
8. [Pendências conhecidas](#8-pendências-conhecidas)
9. [Glossário EN → PT](#9-glossário-en--pt)
10. [Índice de documentos](#10-índice-de-documentos)

---

## 1. O sistema em 5 minutos

Aplicação web para um evento presencial de um dia (~500 participantes, ~200 voluntários). Um único
app Express, com três tipos de sessão — `checkin`, `attendee` e `admin` —, cada uma com seu cookie
e seu tempo de vida.

| Superfície                   | O que faz                                                                                                                             | Código                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Check-in                     | Máquina de estados retomável (`ticket → verification → qr → success`) guardada no servidor. Confirma identidade pelos 4 últimos dígitos do telefone. | `src/modules/checkin/`                           |
| Passe (_pass_)               | Cartão do participante com número de chegada, direitos (camiseta, camiseta de voluntário, almoço, lanche, bebida) e uma faixa (_band_) que gira a cada 30 s para detectar captura de tela. O passe de voluntário mostra ainda a faixa de acesso (_access tier_). | `src/modules/pass/`, `src/constants/pass.ts`     |
| Voluntários                  | `/staff` (retirada de itens, auditoria _append-only_) e `/raffle` (gerador de n° com `randomInt`).                                     | `src/modules/staff/`, `src/modules/raffle/`      |
| Admin                        | Cadastro, busca na porta, métricas ao vivo, envio por WhatsApp, questionário, balcão de camisetas (`/admin/tshirts`, `tshirt:redeem`), permissões de voluntários (`/admin/volunteers`, `volunteers:write`), agenda de boas-vindas do passe (`/admin/pass`, `pass:write`) e retiradas (`/admin/redemptions`). Protegido por escopos. | `src/modules/admin/`, `src/constants/admin-scopes.ts` |
| Questionário                 | Anônimo, uma resposta por pessoa, respostas separadas do registro de quem respondeu.                                                  | `src/modules/survey/`                            |
| WhatsApp                     | Envio dos códigos de ingresso pela Cloud API da Meta; recibos de entrega por _webhook_ assinado.                                       | `src/modules/whatsapp/`                          |

**Stack:** Node 24 executando `.ts` diretamente (sem build no backend), Express 5 + EJS, TypeScript
puro no cliente (esbuild), PostgreSQL 16 com `pg` puro, Redis 8, Caddy, Cloudflare Tunnel,
Tailscale e Cloudflare Access. Visão completa: [`README.md`](../README.md).

**Restrições que explicam muitas decisões:**

- Centenas de celulares atrás do mesmo NAT do local — IP identifica um prédio, não uma pessoa.
- Sem SaaS de telemetria (Sentry, Grafana Cloud): a telemetria é própria. Os fluxos que saem do host
  são poucos e conhecidos: o envio de WhatsApp (Meta), os alertas no Discord (carga útil passada por
  `src/shared/telemetry/scrub.ts`), o _standby_ (§4.9) e, no dia do evento, trechos de log sem
  identificadores colados numa sessão de suporte hospedada
  ([`event-day-support.md`](./operations/event-day-support.md)), o que exige a aprovação do controlador.
- O host é destruído ~24 h após o evento; a destruição **é** a política de retenção. O _standby_
  (§4.9) guarda cópias dos dados num segundo host, que é destruído junto.

---

## 2. Mapa do repositório

| Caminho                     | Conteúdo                                                                                   | Relevância para o revisor                             |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `compose.yml`               | Stack de **desenvolvimento** (bind mount, `user: root`, hot reload).                       | Infra — não é produção                                |
| `compose.prod.yml`          | Stack de **produção**, arquivo independente (não é _override_).                           | Infra — **leitura obrigatória**                       |
| `compose.fallback.yml`      | Stack de contingência (_fallback_): sem banco, cache nem segredos de produção. Ver [`fallback.md`](./operations/fallback.md). | Infra                                  |
| `compose.loadtest.yml`      | Cópia da pilha de produção para o teste de carga (§4.8).                                   | Infra                                                 |
| `Dockerfile`                | Estágios `dev`, `build`, `migrate`, `fallback`, `release`, `context-check`, `prod` (§4.3). | Infra                                                 |
| `Caddyfile`                 | Dois _listeners_: `:80` público e `:8080` admin.                                           | Infra + segurança — **leitura obrigatória**           |
| `tailscale/serve.json`      | `tailscale serve` → `proxy:8080`, Funnel desligado.                                        | Infra                                                 |
| `.env.example`              | Toda a superfície de configuração, comentada.                                              | Segredos                                              |
| `src/server.ts`             | Boot: espera dependências, inicia telemetria, _shutdown_ gracioso.                         |                                                       |
| `src/app.ts`                | Helmet/CSP com _nonce_, cache estático, `/healthz` e `/readyz` (só pela tailnet), `loadShed`, gate do Cloudflare Access. | Segurança — **leitura obrigatória**                   |
| `src/api/index.ts`          | Router `/api/v1`; a ordem dos _middlewares_ é carga estrutural.                            | Segurança — **leitura obrigatória**                   |
| `src/config/csp.ts`         | Diretivas da CSP do Helmet, compartilhadas por `src/app.ts`, pela suíte de _snapshots_ e pelos builds estáticos. Recebe a fonte do _nonce_ por callback, para cada resposta ter o seu. | Segurança — **leitura obrigatória**                   |
| `src/config/env.ts`         | Toda variável de ambiente, validada no boot; configuração incompleta impede o boot.        | Segredos                                              |
| `src/middleware/`           | 22 preocupações transversais (rate limit, same-origin, content-type, captcha, auth…).      | Segurança                                             |
| `src/modules/<domínio>/`    | Um módulo por funcionalidade (ver anatomia abaixo).                                        |                                                       |
| `src/shared/`               | `db`, `errors`, `logger` (redação), `telemetry` (scrub, alertas), `utils`.                 | Privacidade em logs                                   |
| `src/web/`                  | Rotas de página, views EJS, cliente TS, conteúdo em Markdown, webroot.                     | CSP, vazamento em URL                                 |
| `migrations/`               | 001–039, `node-pg-migrate`, incluindo os `GRANT`s por coluna.                              | Segurança de dados                                    |
| `scripts/db/`               | `init/01-roles.sh` (papéis), SQL de exportação e expurgo, importadores de CSV, seed, gerador de códigos de ingresso (`npm run codes`). | Segurança de dados + retenção |
| `scripts/container-egress-filter.*` | Filtro de saída dos contêineres (systemd + `DOCKER-USER` + `INPUT`, §4.6).          | Infra do host                                         |
| `scripts/admin/`            | CLI de administradores; conecta direto no Postgres como _migrator_.                        | Acesso privilegiado                                   |
| `scripts/compose/`          | Testes estáticos que guardam os arquivos compose (`env-scope`, `hardening`, `image-pins`, `network-egress`, `prod-cli-placement`, `source-ownership`). | Infra — mudança aqui é ponto de revisão |
| `scripts/qr/`, `scripts/telemetry/`, `scripts/whatsapp/` | CLIs que carregam `src/config/env.ts`; únicas pastas de `scripts/` copiadas para a imagem `prod` (§4.2). | Infra |
| `scripts/support/`          | `strip-log.sh`: remove identificadores de trechos de log antes de colá-los numa sessão de suporte. | Privacidade |
| `scripts/docs/`             | `links.test.ts`: os links relativos entre documentos precisam resolver. `screenshots.ts` (`npm run docs:screenshots`) captura as telas da demo em `docs/images/screenshots/`. |                                                       |
| `scripts/static/`, `scripts/demo/` | _Builds_ estáticos para o Cloudflare Pages: a página de encerramento e a demo pública. Ver [`static-site.md`](./operations/static-site.md) e [`demo-site.md`](./operations/demo-site.md). | Segurança — o _build_ troca os _nonces_ por _hashes_ dos scripts inline que o navegador executa (blocos `type="application/json"` não entram); o da demo falha se a política passar de 2.000 caracteres (limite do valor de cabeçalho do Cloudflare) |
| `src/web/client/demo/`      | Mock, no navegador, da API de participante, staff e sorteio; usado só pelo _build_ da demo. | Não pode entrar no _bundle_ de produção: nenhum ponto de entrada de `scripts/build-client.ts` o importa, e `scripts/demo/build.test.ts` confere que `js/demo` não existe no webroot |
| `src/fallback/`             | Servidor de contingência (estágio `fallback`, §4.9); sem banco, cache nem segredo.         | Infra                                                 |
| `scripts/standby/`          | _Warm standby_ em um segundo host: snapshot de Postgres e Redis a cada minuto por chave SSH com _forced command_, mais recuperação de lacuna (`recover-gap.sh`). Ver [`standby.md`](./operations/standby.md). | Infra + dados pessoais                  |
| `docs/`                     | O raciocínio por trás das decisões. Ver [índice](#10-índice-de-documentos).                |                                                       |

### Anatomia de um módulo

Todo módulo em `src/modules/<domínio>/` usa o mesmo vocabulário de arquivos. `src/modules/attendee/`
é o exemplo de referência.

```text
<domínio>.routes.ts           router Express; a ordem de montagem é documentada
<domínio>.controller.ts       fino — lê a requisição, delega, responde
<domínio>.service.ts          regras de negócio
<domínio>.repository.ts       todo o SQL daquela tabela, e nada mais
<domínio>.session.model.ts    formato da sessão        ┐ quando a superfície
<domínio>.session.adapter.ts  wrapper tipado           ┘ tem sessão própria
```

Consequência para a revisão: **SQL fora de um `*.repository.ts` é um sinal de alerta**, assim como
um controller com regra de negócio.

---

## 3. Por onde começar

Ordem de leitura sugerida para uma primeira revisão de infraestrutura e segurança (~2 h):

1. `compose.prod.yml` — serviços, redes, o que cada contêiner recebe do ambiente.
2. `Caddyfile` — quem pode falar com qual _listener_, e quais cabeçalhos são confiáveis.
3. `src/app.ts` — cabeçalhos, CSP, sondas, gate do Access.
4. `src/api/index.ts` — a cadeia de _middlewares_ da API.
5. `src/config/env.ts` — segredos e as recusas no boot.
6. `scripts/db/init/01-roles.sh` + `migrations/005_app-role-grants.ts` — privilégio mínimo no Postgres.
7. [`docs/security/security-overview.md`](./security/security-overview.md) — a postura atual por camada, o que é
   intencional (_Load-bearing by design_), os riscos aceitos, as pendências (_Open items_) e o histórico das
   três auditorias (agosto, setembro e outubro de 2026).
8. [`docs/operations/standby.md`](./operations/standby.md) §1 + `scripts/standby/` — o caminho pelo qual cópias
   completas dos dados saem do host durante o evento (ver §4.9). O outro, em escala bem menor, é o suporte no
   dia do evento ([`event-day-support.md`](./operations/event-day-support.md)).

---

## 4. Infraestrutura

### 4.1 Topologia

```text
Internet ──▶ Cloudflare edge ──▶ (túnel de saída) ──▶ cloudflared ──▶ caddy :80   ──▶ app ──▶ db
Tailnet  ──▶ tailscale serve (sidecar vpn) ─────────────────────────▶ caddy :8080 ──┘  │  └──▶ cache
                                                                                       └──▶ app-egress ──▶ Turnstile, Access, Meta
(tunnel e vpn saem para a Cloudflare e a Tailscale pela rede egress; o proxy não tem rota para fora)
```

Sete serviços em cinco redes, separados por fronteira de confiança:

| Serviço                | Redes                                    | Alcançável a partir de      |
| ---------------------- | ---------------------------------------- | --------------------------- |
| `tunnel` (cloudflared) | `edge` _(internal)_, `egress`            | —                           |
| `vpn` (tailscale)      | `edge` _(internal)_, `egress`            | dispositivos da tailnet     |
| `proxy` (caddy)        | `edge` _(internal)_, `web` _(internal)_  | tunnel, vpn                 |
| `app`                  | `web` _(internal)_, `app-egress`, `data` _(internal)_ | proxy          |
| `migrate`              | `data` _(internal)_                      | — (perfil `tools`)          |
| `db`, `cache`          | `data` _(internal)_                      | app e migrate apenas        |

`egress` (só `tunnel` e `vpn`) e `app-egress` (só `app`) são as duas únicas redes com rota para fora.

- **Nenhuma porta é publicada no host.** O tráfego público entra pelo túnel da Cloudflare (conexão
  de _saída_) e o administrativo pelo sidecar do Tailscale.
- `data` é `internal: true`: Postgres e Redis não têm rota para fora do host. Quem tiver o
  `TUNNEL_TOKEN` não chega ao banco — o cloudflared nem consegue **resolver** `db` ou `cache`, porque
  o DNS embutido do Docker é por rede.
- `edge`, `web` e `data` são `internal: true`. O `proxy`, que fala com os dois _listeners_, **não tem
  rota para fora**. O `app` sai por `app-egress`, e só ele: Turnstile (`challenges.cloudflare.com`), as
  chaves do Access (`<team>.cloudflareaccess.com`) e a Graph API do WhatsApp (`graph.facebook.com`).
  Tirar o `app` de `app-egress` quebra o captcha e tranca os administradores fora do caminho público.
- `tunnel` e `vpn` nunca entram em `web` nem em `app-egress`, e o `app` nunca entra em `egress`: o
  `X-Admin-Gate` só é confiável porque o `proxy` (que o remove do tráfego público) é o único par de borda que alcança `app:3000`.
- `edge` é fixada em `172.30.0.0/24` (prod) e `172.31.0.0/24` (dev, onde `web` e `edge` não são
  `internal` e só há três redes), com o IP do sidecar em `.250`. Os valores vêm das âncoras `x-edge-subnet` / `x-vpn-ip` no compose e chegam ao `Caddyfile` pelo
  ambiente do serviço `proxy` — um único lugar para mudar.

Detalhes: [`deployment.md`](./operations/deployment.md#the-stack).

**O que verificar**

- Nenhum `ports:` em nenhum serviço de `compose.prod.yml`.
- Nenhum serviço novo na rede `data` além de `app` e `migrate`, e nenhum serviço além do `app` em
  `app-egress`. `scripts/compose/network-egress.test.ts` guarda isso: `edge`, `web` e `data` seguem
  `internal`, `tunnel`/`vpn` ficam fora de `web`, e só `proxy`, `db`, `cache` e `migrate` dividem rede
  com o `app`.
- Endurecimento por serviço (`read_only`, `cap_drop`, limites de memória e processos, exceto no `app`)
  em `hardening.test.ts`; toda imagem fixada por _digest_ em `image-pins.test.ts`.
- Nenhum serviço de `compose.prod.yml` usa `env_file`: cada um recebe variáveis nomeadas, e `app` e
  `migrate` só as que leem (`scripts/compose/env-scope.test.ts` guarda a lista). Segredos de outro
  serviço (superusuário, túnel, Tailscale) não entram em `app`; os do migrador só em `migrate`.
- Qualquer mudança em `EDGE_SUBNET`/`VPN_IP` respeita as restrições da seção _Network_ do
  `.env.example`: a sub-rede é uma fronteira de confiança.

### 4.2 Desenvolvimento × produção

`compose.prod.yml` é um arquivo **independente**, não um _override_ carregado com `-f`: o Compose
_mescla_ `volumes:`, então um _override_ não conseguiria remover o bind mount de desenvolvimento e a
produção serviria uma cópia gravável do repositório. Um `docker compose` sem `-f` sempre resolve
para o arquivo de **desenvolvimento** ([`deployment.md`](./operations/deployment.md#which-compose-file-runs)).

| Aspecto               | `compose.yml` (dev)                   | `compose.prod.yml` (prod)                                   |
| --------------------- | ------------------------------------- | ----------------------------------------------------------- |
| Estágio do Dockerfile | `dev`                                 | `prod`                                                      |
| Usuário               | `root` (restrição do Docker rootless) | `node` no `app` e no `migrate`; `proxy`, `cache` e `db` têm usuário próprio |
| Código                | bind mount `./:/usr/src/app`          | copiado na imagem                                           |
| Sistema de arquivos   | gravável                              | `read_only: true`, `tmpfs: /tmp`; no `app`, só o volume `logs` é gravável (e executável: aceito, ver auditoria de outubro §6.3) |
| Capabilities          | padrão                                | `cap_drop: ALL`, `no-new-privileges:true`                   |
| Migrações             | `docker compose run --rm app npm run dev:migrate` (dentro do contêiner: `data` é interna, o host não alcança o `db`) | `docker compose --profile tools run --rm --build migrate` (as CLIs de `scripts/admin`, `scripts/db` e `scripts/survey` rodam no mesmo serviço: `docker compose run --rm [-T] migrate node scripts/…`; as de `scripts/qr`, `scripts/telemetry` e `scripts/whatsapp` carregam `env.ts` e rodam no `app`: `docker compose exec app node scripts/…`); sem `--build` roda as migrações da última imagem construída |
| Logs do Docker        | ilimitados                            | `json-file`: `app` 10 MB × 20 (o log de requisições é o único registro das bem-sucedidas), demais 10 MB × 5 |

### 4.3 Imagem (`Dockerfile`)

| Estágio   | Papel                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `dev`     | `npm install` completo, `npm run dev:app`.                                                                |
| `build`   | Gera o bundle do navegador (esbuild é devDependency).                                                     |
| `migrate` | Herda de `build`; ferramentas de DDL **nunca** vão para a imagem que serve tráfego.                       |
| `fallback` | Imagem independente da contingência: `npm ci --omit=dev`, `node src/fallback/server.ts` (§4.9).          |
| `release` | Roda `git describe` sobre `.git` montado temporariamente; só o arquivo `/RELEASE` passa adiante.          |
| `context-check` | Não é imagem de execução: `npm run check:docker-context` falha se `.env`, `.ignore`, logs, chaves ou estado de ferramentas entrarem no contexto de build. |
| `prod`    | `npm ci --omit=dev`, copia o bundle de `build`, cria `/var/log/pelicanpass` como `node`, `USER node`, `HEALTHCHECK` em `/healthz`. |

O `.dockerignore` é uma _allow-list_ (`*` e depois `!src`, `!migrations`, `!scripts`…), então um arquivo
novo no repositório não chega a um `COPY` por padrão. Imagens e `FROM`s são fixados por _digest_
(`scripts/compose/image-pins.test.ts`). A `prod` copia só `scripts/{qr,telemetry,whatsapp}`, sem
`*.test.ts` nem fontes do cliente, e tudo sob `/usr/src/app` pertence a `root`
(`source-ownership.test.ts`).

`/healthz` não toca Postgres nem Redis — de propósito, para que uma oscilação do banco não reinicie
o contêiner no meio do evento. `/readyz` é a sonda que consulta as dependências.

### 4.4 Caddy — dois _listeners_

| | `:80` (vhost público, `http://{$SITE_HOST}`) | `:8080` (admin) |
| --- | --- | --- |
| Único par aceito | a sub-rede `edge` (`EDGE_SUBNET`); fora dela → 403 | o sidecar (`VPN_IP/32`); fora dele → 403 |
| IP do cliente lido de | `CF-Connecting-IP`, só de par confiável | `X-Forwarded-For`, que o `tailscale serve` **substitui** (não concatena) |
| `X-Admin-Gate` | **removido** de toda requisição (`header_up -X-Admin-Gate`) | **definido** como `tailnet` |
| Caminhos | tudo; `/readyz` → 403 | só `/admin*`, `/api/v1/admin*`, `/readyz` e estáticos; resto de `/api/*` e `/healthz` → 403; qualquer outro caminho → redireciona para `/admin` |

Pontos que parecem descuido e não são:

- `trusted_proxies` é um `/24`, não `172.16.0.0/12` — o `/12` incluiria a rede `web` e o próprio app
  poderia se passar por proxy e escolher o seu `req.ip`.
- `{client_ip}`, não `{http.request.header.CF-Connecting-IP}`: a forma de cabeçalho copia o valor sem
  perguntar quem o enviou.
- `SITE_HOST` usa `:?` no compose porque, vazio, o Caddy aceitaria qualquer `Host` em vez de falhar.
- O `:8080` remove `CF-Connecting-IP` mesmo sem lê-lo: nos logs, ele é a verificação independente do
  `req.ip`, e um cliente da tailnet não pode escrevê-lo.

Detalhes: comentários no próprio `Caddyfile` e
[`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md#the-caddy-header-contract).

### 4.5 Cloudflare

- **Tunnel:** `TUNNEL_TOKEN` vai por variável de ambiente, não por `argv`.
- **Regras WAF personalizadas** (quatro): bloqueio fora do Brasil; Managed Challenge em todo o site
  (exceto `/healthz` e o webhook do WhatsApp); somente `POST` em `/api/v1/checkin/*`; e o webhook
  aceito apenas do ASN da Meta.
- **Access:** `/admin` e `/api/v1/admin` no hostname público exigem uma política Access (lista
  explícita de e-mails, One-time PIN). A origem **revalida** a asserção — ver §5.2.

O painel da Cloudflare não é versionado; [`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md) é o registro
a partir do qual ele é reconstruído. **Revise mudanças de regra contra esse arquivo.**

### 4.6 Host

- Nenhuma porta publicada: toda entrada chega por conexões de saída dos contêineres (Cloudflare
  Tunnel, _sidecar_ do Tailscale).
- Docker **rootless**: o firewall do host não cobre o tráfego contêiner → host.
- Saída dos contêineres para RFC1918, link-local e a faixa CGNAT do Tailscale é descartada na cadeia
  `DOCKER-USER`, recriada a cada início do daemon por uma unit systemd de usuário
  (`scripts/container-egress-filter.sh`, `scripts/container-egress-filter.service`).
- O mesmo filtro descarta conexões **novas** em `INPUT` vindas das pontes (`br-+`, `docker0`): um
  contêiner que fala com o gateway da própria ponte é entregue localmente e nunca passa por
  `DOCKER-USER`. Instalações antigas não têm essa regra: reexecute `install` e confira o item 7 da
  verificação.

Tudo isso em [`container-containment.md`](./infrastructure/container-containment.md), incluindo a bateria de
verificação da [§6](./infrastructure/container-containment.md#6-verification).

### 4.7 Dados, cache e logs

- **Postgres — três papéis**, criados por `scripts/db/init/01-roles.sh` na primeira inicialização:
  `app` (DML restrito por coluna, sem DDL), `migrator` (DDL, dono do schema) e `readonly`. Nenhum é
  superusuário: um superusuário tem `COPY … FROM PROGRAM`, o que transformaria qualquer SQL injection
  em execução remota de código no host do banco. O superusuário do contêiner (`POSTGRES_SUPERUSER`) é
  outra variável, de propósito. Ver [`db-cheatsheet.md`](./operations/db-cheatsheet.md#which-role-for-what).
- **Redis:** sessões, _buckets_ de rate limit, tokens de passe de uso único, contadores de métricas.
  A senha é obrigatória (`REDIS_PASSWORD:?`) e é passada como `--requirepass`.
- **Logs:** tudo vai para stdout (limitado pelo driver `json-file`); `warn` ou acima vai também para
  NDJSON rotativo no volume `logs`, que contém IPs e IDs de atores e está inventariado em
  [`data-retention.md`](./security/data-retention.md).

**O que verificar**

- Uma tabela nova só é legível pelo `app` depois que a migração dela faz o `GRANT` — não existem
  privilégios padrão para esse papel, de propósito. Confira o `GRANT` na migração.
- Nenhuma migração ou script concede `SUPERUSER`, `CREATEROLE` ou `BYPASSRLS`.
- Todo acesso a dados filtra por `event_id`.

### 4.8 Capacidade e testes de carga

O app é um único processo Node: o teto é um núcleo, e a velocidade por núcleo pesa mais que a
quantidade de núcleos ou de memória. A capacidade foi medida com k6 contra uma cópia da pilha de
produção (`compose.loadtest.yml`): mesma imagem, mesmo ajuste do Postgres, mesmo pool, contêiner
somente leitura; alertas, WhatsApp, captcha e portões de data trocados por configurações de teste.

**Como foi testado**

- As execuções seguem uma ordem. As de 1 a 3 medem o equilíbrio dos limiters: a sala atrás de um IP,
  com e sem o IP do local em `TRUSTED_IPS`, e misturas de CGNAT. A 4 mede a capacidade com o
  _load shedding_ desligado, e a 5, o _shedding_ além do _knee_.
- Um _ladder_ por fase (`scripts/loadtest/ladder.ts`): a carga dobra até um degrau (_rung_) falhar,
  depois faz bisseção até o _knee_ e repete os dois lados dele. Cada degrau começa com banco e Redis
  zerados.
- Um degrau com mais de um núcleo de outra carga no host, ou um segundo de _thermal throttling_, é
  marcado como inválido e repetido.
- Cada degrau é uma linha versionada em `loadtest/history/`.
  [`load-test-results.md`](./performance/load-test-results.md) é gerado a partir delas, e `npm run check` falha
  se estiver desatualizado.

**Resultados do evento de 2026.** `SCALE=1` é uma sala de 500 participantes, o tamanho do evento;
usuários = `SCALE` × 500. _Confortável_ é o último degrau com latência estável (p95 abaixo de
20 ms) e o número para planejar; _capacidade_ é o último que passou.

| Host                                  | Hardware                                   | Interações, confortável | Interações, capacidade | Knee | Questionário               |
| ------------------------------------- | ------------------------------------------ | ----------------------- | ---------------------- | ---- | -------------------------- |
| `prod-server`, host do evento              | Xeon E3-1220 v5, 4 núcleos, 8 GB, SSD SATA | 7: 3.500                | 8: 4.000               | 9    | sem knee até 20: ≥ 10.000  |
| `dev-server`, notebook de desenvolvimento | i7-1260P, app nos núcleos de desempenho    | 10: 5.000               | 11: 5.500              | 12   | sem knee até 20: ≥ 10.000  |

- As interações são o limite: depois de cada interação, quase toda a sala recarrega o passe em um minuto. No
  _knee_, o app passa de um núcleo: 129–136% nos degraus 8 a 16 do `prod-server`, segundo o relatório gerado
  ([`load-test-results.md`](./performance/load-test-results.md)), e o Postgres fica perto de 40%.
- Com o _shedding_ desligado, o host do evento em `SCALE=16` respondeu 11,0% das requisições com 5xx,
  e 11,2% dos fluxos falharam. Com os limites padrão ligados, atendeu `SCALE=9`, 16 e 20 sem 5xx e
  sem fluxo falho, com p95 de 258, 543 e 656 ms, recusando 2,6–26% das requisições com `503` e
  `Retry-After`. O p95 passou do limite de 500 ms em 16 e 20
  ([`overload-behaviour.md`](./performance/overload-behaviour.md#load-shedding)).
- Os números são **deste host e destes commits do arquivo privado** (`prod-server` em `d02ad58`, 2026-10-14; `dev-server` em `650e5c3`, 2026-09-30). Outro host — o
  de um próximo evento, ou a máquina de quem clonar o repositório — roda o mesmo procedimento a partir
  de [_First session on a new host_](./performance/load-testing.md#first-session-on-a-new-host), e as linhas dele
  entram no mesmo relatório.

**O que não foi medido**

- **Capacidade do local.** Nos degraus de capacidade cada telefone tem um IP próprio, então nenhum
  limiter atua. Uma sala atrás de um IP só passa com esse IP em `TRUSTED_IPS`, que as execuções 1 a 3
  medem.
- **O caminho inteiro.** O k6 chama `app:3000` direto: Cloudflare, túnel, Caddy e o _uplink_ do host
  ficam de fora. O k6 também divide o host (cerca de um dos quatro núcleos no _knee_): para o app, os
  números são um limite inferior; para o sistema, um limite superior.

Raciocínio completo: [_What the numbers mean for an event_](./performance/load-testing.md#what-the-numbers-mean-for-an-event).

**O que verificar**

- Um PR que mexe em caminho quente (passe, gerador de n°, questionário, check-in) muda o `app_tree`, e os
  resultados anteriores deixam de valer para ele. Peça uma sessão do _ladder_ no host do evento e o
  commit do relatório regenerado.
- `LOAD_SHED_ENABLED` continua `true` por padrão em `env.ts` e em `.env.example`.
- Uma mudança em `loadtest/` muda o `harness_tree`. O relatório separa as linhas antigas das novas, e
  isso é esperado.

### 4.9 Contingência: fallback e standby

Dois mecanismos separados, para falhas de tamanhos diferentes.

- **Fallback** ([`fallback.md`](./operations/fallback.md)): servidor independente (`npm run fallback`, estágio
  `fallback` do `Dockerfile`, `compose.fallback.yml`) que mantém o hostname público respondendo
  durante um reinício. Serve a contagem regressiva, o aviso de privacidade, os termos e, depois de
  `EVENT_CLOSES_AT`, a página de encerramento — sem banco, cache nem segredo de produção. Qualquer
  `/api/**` ou método diferente de `GET` recebe `503` com `Retry-After` e, depois de `EVENT_CLOSES_AT`,
  `410 EVENT_CLOSED`.
- **Warm standby** ([`standby.md`](./operations/standby.md)): uma segunda pilha completa de produção em outro
  host, para quando o host principal some por mais tempo. Um _timer_ systemd de usuário puxa a cada
  minuto um snapshot validado (`pg_dump` + RDB do Redis) por uma chave SSH com _forced command_.
  `scripts/standby/restore.sh` sobe o segundo host com as sessões intactas e reserva 500 números de
  check-in (nenhum número emitido depois do snapshot é reemitido); `cutback.sh` devolve o tráfego.

O snapshot é **puxado**, não empurrado: o host principal não ganha porta nem rota nova, e `data`
continua `internal`. Ele ganha, sim, uma linha no `authorized_keys`, e o SSH chega a ele por um hostname
atrás do Cloudflare Access.

**O que verificar**

- A chave de snapshot só pode rodar `snapshot.sh`: no `authorized_keys` do host principal ela tem
  `from="…",command="…/snapshot.sh",restrict` — sem shell, PTY nem _forwarding_. A chave é sem
  _passphrase_, mas o _forced command_ não é a única barreira: `from=` limita a origem ao endereço de
  entrega do túnel (não distingue o `dev-server` de outro cliente do túnel), e quem consegue abrir o túnel
  é a política Access do hostname SSH (serviço do `dev-server` e operadores).
- Snapshots, tars de _cut-back_ e `pre-restore-*.dump` guardam todos os telefones em texto claro, em
  `~/standby` nos **dois** hosts (`0600`). Estão no inventário de
  [`data-retention.md`](./security/data-retention.md) e são destruídos no _teardown_, junto com a linha do
  `authorized_keys`, o _timer_ e os volumes do segundo host.
- O fallback não lê o `.env` de produção: o `compose.fallback.yml` usa o seu próprio, só com horários
  do evento e o token do túnel.
- Mudança em `scripts/standby/` ou em `restore.sh` pede o ensaio de [`standby.md` §8](./operations/standby.md#8-rehearsal--before-the-event).

---

## 5. Segurança

### 5.1 Fronteiras de confiança

| Fronteira                        | Controle                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet → origem                | Cloudflare (WAF, Challenge, Access) → túnel → Caddy só aceita a sub-rede `edge`.                                                                                                          |
| Tailnet → origem                 | `tailscale serve` → Caddy `:8080` só aceita o IP do sidecar.                                                                                                                              |
| Proxy → app                      | O app confia em exatamente um salto (`trust proxy` = 1) e no `X-Forwarded-For` que o Caddy reescreve com `{client_ip}`. O `X-Admin-Gate` só vale porque o vhost público o remove e só o `proxy` (e `db`, `cache`, `migrate`) divide rede com o `app`. |
| App → dados                      | Rede `data` interna; papel `app` sem DDL, com `GRANT`s por coluna.                                                                                                                        |
| Contêiner → internet             | Só `tunnel`/`vpn` (rede `egress`) e `app` (rede `app-egress`) têm rota para fora; `proxy`, `db` e `cache` não discam.                                                                      |
| Contêiner → host / LAN / tailnet | Filtro de saída em `DOCKER-USER`.                                                                                                                                                         |
| CLIs de operação                 | Rodam em `migrate` (conectam como `migrator`), exceto `scripts/qr`, `scripts/telemetry` e `scripts/whatsapp`, que rodam em `app`.                                                         |
| Host → fora                      | Cópias do _standby_ e trechos de log sem identificadores no suporte do dia do evento (ver §1 e §4.9).                                                                                     |

### 5.2 Os dois caminhos do admin

`src/app.ts` monta `requireAccessAssertion`
(`src/middleware/access-jwt.middleware.ts`) em `/admin` e `/api/v1/admin` **antes** de qualquer
router, então vale para toda rota administrativa atual e futura.

- **Pelo hostname público:** a Cloudflare Access exige identidade; a origem verifica a assinatura, o
  emissor e, principalmente, o `aud` do JWT com `jose`. O `aud` é o que distingue nossos tokens de
  outros aplicativos Access do mesmo time. O algoritmo é fixado em **RS256** e um token sem `kid` é
  recusado (sem isso o `jose` tentaria todas as chaves do conjunto). Token recusado loga só `code` e
  `claim`, nunca o e-mail, e o cabeçalho `cf-access-jwt-assertion` está em `REDACT_PATHS`.
- **Pela tailnet:** o `:8080` do Caddy define `X-Admin-Gate: tailnet` e o gate deixa passar. Isso é
  seguro **somente** porque o vhost público remove esse cabeçalho de toda requisição.
- **Falha fechada:** sem `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`, toda requisição que não venha da
  tailnet recebe 403. Na origem, sem asserção nem `X-Admin-Gate`, `/admin/login`, `/admin` e
  `/api/v1/admin/*` respondem **403**.
- **`/readyz` também é fechado no app:** `requireTailnet` responde **404** (não 403) sem
  `X-Admin-Gate: tailnet`, e `readyzRateLimit` (em memória) limita o resto. O vhost público responde
  403 antes disso.

Depois do gate vêm login com senha (scrypt + _salt_ + _pepper_ `ADMIN_PASSWORD_PEPPER`,
`src/modules/admin/admin.password.ts`), Turnstile no formulário e escopos por recurso
(`src/constants/admin-scopes.ts`). O menu só mostra seções cujo escopo a rota também exige, e cada
gate relê o Postgres: mudar o escopo de alguém vale na próxima requisição.

Detalhes: [`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md#cloudflare-access--the-administrator-surface).

### 5.3 A cadeia de _middlewares_ da API

A ordem em `src/api/index.ts` é carga estrutural e está comentada em cada montagem:

```text
noStore                         ← Cache-Control em toda resposta da API, inclusive recusas
  → limiter por IP              ← pula IP_LIMIT_EXEMPT (abaixo)
  → content-type (415 se declarado e não for JSON; sem Content-Type passa)
  → same-origin                 ← Origin em métodos que alteram estado; webhook isento
  → /client-errors              ← acima do parser global, limite próprio de 4 kb
  → /whatsapp/webhook/<secret>  ← só se WHATSAPP_WEBHOOK_ENABLED; acima do parser: a Meta assina os bytes crus
  → express.json (10 kb, inflate: false)   ← Content-Encoding que não seja identity: 415
  → normalização de erros do parser (400/413/415, não 500)
  → rejectNulInput              ← NUL em query e corpo (inclusive chaves): 400, não 500 no Postgres
  → eventClosedGate             ← /checkin, /attendee, /survey, /staff, /raffle: 410 após o evento
  → /checkin                    ← gate de janela, antes de existir sessão
  → resolveSessions
  → cobrança tardia do limiter por IP   ← caminhos isentos sem sessão de participante
  → /admin/auth                 ← limiter de login, depois captcha
  → /admin/metrics, /admin/whatsapp/runs/current, /admin/redemptions/summary
                                ← polls fora do orçamento do /admin
  → limiter por superfície + gates de papel/permissão
  → redisOutageToUnavailable    ← Redis fora: 503 + Retry-After: 5 (admin fica como estava)
  → error handler
```

Depois do evento o `eventClosedGate` só deve uma recusa `410`; `/admin` fica aberto para o _teardown_.

- **`IP_LIMIT_EXEMPT`** (`/attendee/pass`, `/attendee/status`, `/survey` e o prefixo do webhook) não
  paga o limiter por IP porque, atrás do NAT do local, a sala inteira é um IP. Quem protege esses
  caminhos é a sessão (que não se cria sem passar pelo check-in) e o limiter da sessão; sem sessão
  de participante resolvida, a cobrança tardia aplica o limiter por IP (ver §6).
- **Same-origin:** em método que altera estado, `Origin` ausente é recusado, a menos que venha
  `Sec-Fetch-Site: same-origin`; `Origin: null` só passa com esse mesmo cabeçalho (formulários
  próprios sob `Referrer-Policy: no-referrer`). O webhook é isento: a Meta posta de servidor para
  servidor, sem `Origin` e sem cookie, e o HMAC é o controle dele. Quem fala sem navegador pode
  forjar o cabeçalho: a regra defende o navegador da vítima, não cliente com _script_.
- **Redis fora do ar:** superfícies de participante, voluntário, gerador de n° e check-in respondem 503 com
  `Retry-After` em vez de tratar uma sessão válida como inexistente; o admin não muda
  (`src/middleware/redis-outage.middleware.ts`).

Envolvendo tudo, em `src/app.ts`: log de requisição, contadores, Helmet com CSP por _nonce_,
`Permissions-Policy`, `cookie-parser`, arquivos estáticos (fora de qualquer limiter), `/healthz` e
`/readyz` (este atrás de `requireTailnet` e `readyzRateLimit`, ver §5.2), e só então o _load
shedding_, o gate do Access (`/admin`, `/api/v1/admin`) e os routers. As sondas e os estáticos
ficam acima do _shedding_, então continuam respondendo sob sobrecarga.

A CSP é a do Helmet com três ajustes: `script-src 'self'` + Turnstile + _nonce_; `style-src 'self'`
+ _nonce_, **sem `'unsafe-inline'`**; `font-src 'self'`. `frame-ancestors` é o padrão do Helmet,
`'self'` (com `X-Frame-Options: SAMEORIGIN`), **não** `'none'`: a página pode ser emoldurada por ela
mesma. As diretivas ficam em `src/config/csp.ts`; o teste `src/app.csp.test.ts` guarda a política
servida por `src/app.ts`.

O router web (`src/web/routes/web.routes.ts`) tem cadeia própria — limiter, `localeMiddleware`,
`rejectNulInput`, `closingGate`, `resolveSessions`, `landingGate` — e é onde ficam os únicos
formulários HTML com `POST` (continuar o check-in, ações do admin). Todos usam `formBody`:
same-origin, `urlencoded` de 1 kb sem `inflate` e `rejectNulInput`.

Em produção o app serve pt-BR e `en` (inglês); `en-XA` só existe fora dela. O `localeMiddleware` escolhe
o idioma por `?lang=` (que grava o cookie `locale` e redireciona sem o parâmetro), depois pelo cookie,
depois por `Accept-Language`, e por fim pelo pt-BR; o seletor de idioma oferece a troca. Como a
resposta passa a depender do cookie e de `Accept-Language`, ambos entram no `Vary`.

**O que verificar:** qualquer PR que mova uma linha nesse arquivo. Um parser acima do webhook quebra a
verificação de assinatura; uma rota acima de `resolveSessions` roda sem sessão; uma rota admin nova
fora dos prefixos `/admin` / `/api/v1/admin` escapa do gate do Access; um `POST` novo no router web
sem `formBody` não passa por same-origin.

### 5.4 Sessões e cookies

- Três cookies de sessão: `checkin_session_id`, `attendee_session_id`, `admin_session_id`
  (`src/constants/cookie-names.ts`). Além deles, `locale` e `landing_bypass` (este só existe se o
  token de bypass for apresentado, ver §5.7).
- Chaves no Redis com namespace por tipo e ID em hash (`session:<tipo>:<sha256>`); o tipo é
  revalidado na leitura, então copiar um ID de check-in para o cookie de admin não funciona.
- IDs de 122 bits (`randomUUID()`) e `httpOnly`. `secure` só com `NODE_ENV=production`. `sameSite` é
  `lax` (o link de entrada chega de fora do site e redireciona, então `strict` derrubaria o cookie)
  e `strict` no admin, que nenhum link externo aponta.
- **Os cookies não têm `maxAge`, de propósito**: são cookies de sessão do navegador, e quem expira é o
  TTL no Redis. O de check-in e o de admin deslizam a cada `save`; o de participante é gravado uma vez,
  então seu TTL é **absoluto** desde a criação. O admin tem ainda um teto absoluto,
  `ADMIN_SESSION_MAX_AGE` (12 h por padrão). Os TTLs vêm de `CHECKIN_SESSION_TTL`,
  `ATTENDEE_SESSION_TTL` e `ADMIN_SESSION_TTL`; o padrão no código e o do `.env.example` diferem
  (confira qual vale em produção).
- A sessão fica atrelada a um _hash_ do `User-Agent`; outro `User-Agent` conta como sem sessão (ver §6).
- Há uma sessão de participante viva por pessoa: um novo check-in revoga a anterior por `SET … GET`
  atômico (exige Redis ≥ 6.2, por isso a imagem é fixada).
- Permissões de voluntário (`can_redeem`, `can_draw`) são relidas do Postgres a cada requisição:
  revogar tem efeito no próximo toque.

Código: `src/modules/session/`.

### 5.5 Rate limiting

A pergunta que importa ao revisar: **esse limite é controle de custo ou controle contra tentativa e
erro?** Os limiters por IP são custo — atrás do NAT do local, um IP é o prédio inteiro. Os que
realmente barram adivinhação usam chaves que o atacante não troca: `attendeeId`, usuário admin,
voluntário e um orçamento global de falhas no check-in que liga o Turnstile para todos.

- Todo limiter no Redis tem um `insuranceLimiter` em memória com a **mesma cota**: com o Redis fora do
  ar, o limite não cai para zero, e a falha de armazenamento é registrada e a requisição segue
  (_fail open, with insurance_). O gêmeo em memória é por processo: some num reinício, e apagar a
  chave no Redis não o zera. O `/readyz` usa só o limiter em memória.
- O orçamento de login admin é consumido **antes** do scrypt e zerado no sucesso.

Código: `src/middleware/rate.middleware.ts`. Catálogo, matriz de rotas e operação:
[`rate-limiting.md`](./performance/rate-limiting.md).

### 5.6 Credenciais e enumeração

- Código de ingresso: seis caracteres `[a-z0-9]{6}`, sem hífen (`src/constants/ticket.ts`). O primeiro
  é a chave: `v` voluntário, `d` _walk-in_ criado na porta pelo editor de participantes (reservado:
  o importador de planilha o recusa) e qualquer outra, uma origem externa de inscrição. Os códigos
  gerados usam o alfabeto de `src/modules/admin/admin.ticket-code.ts` (sem vogais e sem `0`, `1`, `3`,
  `4`), e a CLI é `npm run codes`; os validadores não se restringem a esse alfabeto.
- Todo participante, não só voluntário, tem um token de link de entrada opaco de 128 bits, distinto do
  código digitado; é consumido e redirecionado (303) para sair da barra de endereço. Um `GET /checkin?t=`
  vindo de outro site (`Sec-Fetch-Site: cross-site`) não grava sessão: mostra uma página "Continue"
  cujo toque faz `POST` do token.
- `validateTicket` lança **o mesmo** erro para código malformado e código inexistente — não há
  oráculo de enumeração.
- Comparações de segredo em tempo constante (`timingSafeEqual`, com checagem de tamanho antes).
- No admin, nenhum dado de participante trafega em URL de página: filtros, buscas e IDs vão no corpo
  de `POST`, porque o histórico do navegador sobrevive à sessão e pode sincronizar para fora do
  aparelho.
- Os importadores de CSV (`scripts/db/import-attendees.ts` e o de permissões de voluntários)
  recusam entrada acima de 2 MB ou 5.000 linhas, qualquer NUL e célula de texto livre que comece como
  fórmula de planilha (`= + - @`, tab, CR), apontando linha e coluna
  (`src/modules/admin/admin.import-input.ts`).

### 5.7 Segredos

- Referência completa e comentada: `.env.example`. O `.env` real nunca é versionado.
- `src/config/env.ts` valida tudo no boot. Configuração obrigatória ausente, senha fraca ou uma
  integração meio configurada (WhatsApp, questionário) **impede o boot** em vez de degradar.
- Cada contêiner recebe só o que usa: `proxy` recebe `SITE_HOST`, `EDGE_SUBNET`, `VPN_IP` e
  `SERVER_NAME`; `db` recebe as credenciais dos papéis; `tunnel` recebe só `TUNNEL_TOKEN`; `vpn`, a
  chave e as variáveis `TS_*`. Não há `env_file` em produção: `app` e `migrate` só veem o que lêem
  (`env-scope.test.ts`, ver §4.1). Antes de outubro recebiam o `.env` inteiro (F-A2-1).
- `LANDING_BYPASS_TOKEN` é conveniência de ensaio e **precisa estar vazio em produção**
  (item 7 da [lista de verificação](./security/security-overview.md#before-every-event-security-checks) de
  segurança); nada no boot recusa o valor, então a conferência é manual.

### 5.8 Webhook do WhatsApp

`src/modules/whatsapp/whatsapp.signature.ts` verifica `X-Hub-Signature-256` com HMAC-SHA256 sobre os
**bytes crus**, usando o _app secret_ (não o _access token_). **Essa assinatura é a fronteira
inteira**: o sufixo secreto no caminho, a regra de ASN na Cloudflare e os limiters só reduzem
ruído. A rota só é montada com `WHATSAPP_WEBHOOK_ENABLED`; é isenta de same-origin e do limiter por IP
(usa `rl:ip:whatsapp-webhook` e `rl:global:whatsapp-webhook`, dimensionados para um envio) e não passa
por `rejectNulInput`, porque o corpo assinado é lido cru. Ver
[`whatsapp-integration.md`](./features/whatsapp-integration.md).

### 5.9 Logs, telemetria e privacidade (LGPD)

- Pino censura cookies, `authorization`, `x-hub-signature-256`, `cf-access-jwt-assertion` e todo campo
  de corpo que carrega credencial ou dado pessoal (`src/shared/logger/redact-paths.ts`). Logs de
  requisição registram `attendeeId`, número de check-in e papel — nunca nome, telefone ou código de
  ingresso. URLs com segredo (como o `?preview=` da landing) são mascaradas.
- Eventos de telemetria passam por `src/shared/telemetry/scrub.ts`.
- O que sai do host é pouco e conhecido (ver §1): envio de WhatsApp, alertas no Discord com
  deduplicação e carga útil filtrada, o _standby_ e, no dia do evento, trechos de log sem
  identificadores colados num suporte hospedado, com aprovação do controlador. A telemetria em si
  é própria.
- Retenção: o host é destruído ~24 h após o evento, e o mesmo vale para o segundo host do
  _standby_, cujos snapshots (cópias completas de Postgres e Redis em `~/standby`) precisam sumir no
  _teardown_. O que sobrevive é uma exportação **pseudônima** (não anônima). Um `pg_dump` feito
  durante o evento é o modo de falha. Ver [`data-retention.md`](./security/data-retention.md).

**O que verificar:** qualquer campo novo de corpo que carregue credencial ou dado pessoal precisa
entrar em `REDACT_PATHS`; qualquer novo armazenamento de dado pessoal precisa entrar no inventário de
`data-retention.md`.

---

## 6. Não "corrija" isto

Parecem descuidos e são intencionais. A lista completa está em
[_Load-bearing by design_](./security/security-overview.md#load-bearing-by-design); os riscos aceitos e as
decisões em vigor estão em
[_Accepted risks_](./security/security-overview.md#accepted-risks) e
[_Decisions in force_](./security/security-overview.md#decisions-in-force).

- A mensagem de erro idêntica em `validateTicket` (ver §5.6). Deixá-la "mais amigável" cria um
  oráculo.
- `user: root` no serviço `app` de `compose.yml`: restrição real de EACCES no Docker rootless, e só
  no desenvolvimento.
- `header_up -X-Admin-Gate` no vhost público, aplicado a **todos** os caminhos, não só aos de admin.
- `trusted_proxies` como `/24` e `{client_ip}` em vez de ler o cabeçalho direto (ver §4.4).
- `/healthz` sem tocar dependências; `/readyz` bloqueado no vhost público (entrega reconhecimento).
- Ausência de privilégios padrão para o papel `app` no Postgres.
- `INSERT` sem `SELECT` para o `app` em `redemptions`: por isso `redeemItem` não usa `RETURNING`. O
  histórico é lido pela função `redemption_history()` (migração 027).
- `express.json({ limit: '10kb', inflate: false })` e o limite de 2048 caracteres no
  `TurnstileValidator` são os limites de entrada que dispensam uma biblioteca de validação de schema.
  `Content-Encoding` diferente de `identity` é 415, não é decodificado.
- `import './foo.ts'` com extensão `.ts`: Node executa o fonte diretamente, e `./foo.js` passa no
  `tsc` mas quebra no boot. Ver [`typescript-conventions.md`](./development/typescript-conventions.md).
- O k6 chama `app:3000` sem passar pela Cloudflare nem pelo Caddy, e o app aceita o `X-Forwarded-For`
  dele: o app confia em exatamente um salto de proxy, e é assim que um contêiner faz o papel de uma
  sala inteira. A pilha de carga não publica nenhuma porta.
- `.dockerignore` é uma lista de permissão e `loadtest` não está nela: o _harness_ não entra na imagem de produção.
- `attendees.admin_username` não tem chave estrangeira e não concede nada, de propósito: administradores
  não pertencem a um evento e a lista de participantes é expurgada a cada evento. Todo gate admin
  autentica contra `admins` por conta própria, e a coluna é só `SELECT` para o papel `app` (migração
  031).
- Sessões atreladas ao _hash_ do `User-Agent` (N-A3-8): trocar de navegador ou de UA pede novo
  check-in, e a regra vale também após a restauração do _standby_.
- Um `Content-Type` ausente passa pelo gate de 415 (N-A3-3): requisição sem corpo não tem tipo a conferir.
- `IP_LIMIT_EXEMPT` (passe, status, questionário e webhook) pula o limiter por IP de propósito, com
  cobrança tardia sem sessão (ver §5.3). Parece um buraco; o NAT da sala é o motivo.
- Quatro escopos reservados (`attendees:import`, `raffle:read`, `raffle:write`, `admins:write`) não
  guardam nenhuma rota, e conceder um deles não muda nada
  ([`admin-scopes.md`](./features/admin-scopes.md#reserved)).
- O fallback responde `/admin*` com a página de contagem regressiva: ele não tem handler de admin e
  ignora `X-Admin-Gate` (F-A1-7).
- `TURNSTILE_ADMIN_ENFORCE=false` só gera um aviso na partida em produção, e o boot não o recusa: é o
  resgate para uma queda do Turnstile (F-A1-3). Em contrapartida, o login sem captcha deixa um
  usuário nomeado ser bloqueado; por isso o aviso e a conferência na passagem de conformidade.
- Riscos aceitos em outubro de 2026 (motivos em [_Accepted risks_](./security/security-overview.md#accepted-risks)): volumes de dados e de logs graváveis e
  executáveis, porque o Docker rootless não monta volume nomeado `noexec` (F-A4-2, N-A34-3); a senha
  do Redis visível em `docker inspect`, porque um _secret_ do Compose exigiria raiz gravável em `cache`
  (L5).
- `app` tem `mem_limit: 1g` e `pids_limit: 128`, dimensionados depois do evento (decisão de 2026-10-19 em
  [_Decisions in force_](./security/security-overview.md#decisions-in-force)); `hardening.test.ts` exige
  limites em todos os serviços.

---

## 7. Checklist de revisão

### Comandos locais

```bash
npm ci
npm run check   # prettier, eslint, typecheck, i18n (+ inventário e auditoria de textos), survey, redemption, relatório de carga e testes
```

`npm run lint` não é opcional: é o resolvedor do ESLint que pega um especificador de import que o
`tsc` aceita e o Node rejeita.

Os testes que dependem de Docker e das imagens fixadas (`scripts/caddyfile.test.ts`,
`scripts/db/export-results.test.ts`) são ignorados sem eles: um `check` verde sem Docker não exercita
o `Caddyfile`. O `check` não depende de `.env`: `src/test/setup-env.ts` dá aos testes um ambiente
próprio e válido (os segredos do `.env.example` não passam na validação de produção).

Mudança em `.dockerignore`, no `Dockerfile` ou em qualquer coisa que entre no contexto de build
também roda (precisa de Docker):

```bash
npm run check:docker-context   # estágio context-check: falha se .env, .ignore, logs ou chaves entrarem
```

Qualquer mudança em build, compose ou Docker precisa confirmar que o hot reload do desenvolvimento
continua funcionando
(ver _Dev workflow_ em [_Load-bearing by design_](./security/security-overview.md#load-bearing-by-design)):

```bash
docker compose logs -f app   # edite um .ts em src/ e confirme a linha de restart
```

### PR de infraestrutura

Os testes estáticos de `scripts/compose/` (§4) são o que a mudança precisa manter verde; quando a
mudança é legítima, a lista correspondente no teste é atualizada **no mesmo PR**, e essa é a linha a
revisar: `env-scope`, `hardening`, `image-pins`, `network-egress`, `prod-cli-placement` e
`source-ownership`.

- [ ] Nenhuma porta publicada; nenhum serviço novo em `data`.
- [ ] Nenhum `env_file` em `compose.prod.yml`; variável nova entra em `environment:` do serviço que a
  lê e na lista de `scripts/compose/env-scope.test.ts`.
- [ ] O serviço `app` de produção mantém `read_only`, `cap_drop: ALL`, `no-new-privileges` e
      `USER node`.
- [ ] Nada além do `app` em `app-egress`; `tunnel` e `vpn` fora de `web`; o `app` fora de `egress`
      (`network-egress.test.ts`).
- [ ] Imagem ou `FROM` novo fixado por _digest_ (`image-pins.test.ts`).
- [ ] `.dockerignore` continua sendo _allow-list_, e a imagem `prod` copia só
      `scripts/{qr,telemetry,whatsapp}`; uma CLI de operador nova rodada no `app` precisa estar entre
      elas, sem alcançar `scripts/admin/db.ts` (`prod-cli-placement.test.ts`,
      `source-ownership.test.ts`).
- [ ] Mudança de rede ou sub-rede é consistente entre compose, `Caddyfile` e `.env.example`.
- [ ] Mudança de regra na Cloudflare está refletida em `cloudflare-rules.md`.
- [ ] `compose.yml` continua sendo só desenvolvimento; nada de produção foi parar nele e vice-versa.
- [ ] `compose.fallback.yml` continua sem banco, cache, Caddy e `env_file`: o `app` recebe só
      variáveis nomeadas de horário do evento e mantém `read_only`, `cap_drop: ALL` e
      `no-new-privileges`; o túnel usa um token próprio, nunca o da produção.
- [ ] `compose.loadtest.yml` continua estendendo `compose.prod.yml`, sem túnel, proxy, _sidecar_ nem
      porta publicada, com `data` `internal` e alertas, Discord e WhatsApp desligados.
- [ ] Mudança em `scripts/standby/` mantém a chave do snapshot restrita a `snapshot.sh`
      (`command=…,restrict`) e passa pelo ensaio de
      [`standby.md` §8](./operations/standby.md#8-rehearsal--before-the-event).
- [ ] A verificação da [§6 de `container-containment.md`](./infrastructure/container-containment.md#6-verification)
      continua passando no host afetado.

### PR de segurança ou de aplicação

- [ ] Ordem de `src/api/index.ts` preservada, ou a mudança justificada no comentário da montagem.
- [ ] Rota admin nova está sob `/admin` ou `/api/v1/admin` e exige o escopo certo.
- [ ] Rota que altera estado não é `GET` e tem limiter adequado. Na API (JSON), fica sob a cadeia
      de `src/api/index.ts` (content-type e same-origin); no router web, um `POST` de formulário usa
      `formBody` (same-origin, `urlencoded` de 1 kb, `rejectNulInput`).
- [ ] Caminho novo que precise pular o limiter por IP entra em `IP_LIMIT_EXEMPT` com a cobrança
      tardia argumentada (§5.3, §6).
- [ ] Campo novo de corpo com credencial ou dado pessoal entra em `REDACT_PATHS` (§5.9).
- [ ] SQL só em `*.repository.ts`, parametrizado, filtrado por `event_id`.
- [ ] Tabela ou coluna nova tem `GRANT` explícito e mínimo na migração.
- [ ] Nenhum dado de participante em URL, `<title>`, log ou telemetria.
- [ ] Variável de ambiente nova validada em `env.ts` e documentada em `.env.example`.
- [ ] Nenhum script ou estilo inline que exija afrouxar a CSP.
- [ ] Mudança em caminho quente (passe, gerador de n°, questionário, check-in) vem com uma sessão do
      _ladder_ e o relatório regenerado (ver §4.8).

---

## 8. Pendências conhecidas

Não repetidas aqui para não desatualizar:

- Auditoria de outubro de 2026: os passos pré-evento (incluindo o _Stage B_) foram executados antes do
  evento de 2026-10-17, mas os resultados não foram guardados. O pós-evento está concluído, salvo a regra
  de _rate limiting_ de `/checkin` (abaixo). Pendências atuais e a lista de verificação antes de cada
  evento: [_Open items_](./security/security-overview.md#open-items) e
  [_Before every event_](./security/security-overview.md#before-every-event-security-checks).
- Regra de _rate limiting_ de `/checkin` na Cloudflare ainda marcada como não criada em
  [`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md#rate-limiting-rule--not-yet-created).
- Pendências de operação no dia: [`deployment.md`](./operations/deployment.md), seção _Known gaps_.

---

## 9. Glossário EN → PT

| Termo no código/docs  | Significado                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| attendee              | Participante ou voluntário com ingresso (os dois públicos).                           |
| participant           | Participante do evento.                                                               |
| volunteer / staff     | Voluntário; `/staff` é a tela de retirada de itens.                                   |
| audience              | Público: participante ou voluntário.                                                  |
| door                  | Entrada do evento, onde o check-in acontece.                                          |
| check-in window       | Janela em que o check-in é aceito para cada público.                                  |
| landing / curtain     | Tela de contagem regressiva antes da janela abrir. **Não** é controle de segurança.   |
| pass                  | Passe digital do participante.                                                        |
| band                  | Faixa de cor e palavra que muda a cada 30 s no passe e na tela do voluntário.         |
| access tier           | Faixa de acesso do voluntário no passe (`CADASTRO`, `CONSULTA`, `CAMISETAS`, `RETIRADAS`, `GERADOR DE N°`); só um rótulo, cada tela confere a sua permissão. |
| redemption / redeem   | Retirada de um item (camiseta, camiseta de voluntário, almoço, lanche, bebida) a que a pessoa tem direito. |
| entitlement           | Direito a um item.                                                                    |
| raffle / draw         | Interações (cada rodada no evento); a ferramenta e a permissão do voluntário são o gerador de n° (`GERADOR DE N°`, `can_draw`). |
| roster                | Lista de participantes cadastrados.                                                   |
| scope                 | Permissão granular de um administrador.                                               |
| tailnet               | Rede privada do Tailscale.                                                            |
| edge                  | Borda da Cloudflare, ou a rede Docker `edge`, conforme o contexto.                    |
| load-bearing          | Estrutural: parece acidental, mas algo quebra se for mudado.                          |
| go/no-go              | Lista de itens que precisam estar ok antes de abrir as portas.                        |
| teardown              | Exportação, verificação e destruição dos dados após o evento.                         |
| fallback              | Servidor independente, sem banco, que mantém o hostname respondendo durante reinícios. |
| standby               | Segunda pilha completa em outro host, alimentada por snapshots a cada minuto.         |
| closing page          | Página de agradecimento exibida a partir de `EVENT_CLOSES_AT`.                        |
| fail closed           | Em caso de falha, negar em vez de permitir.                                           |
| key / chave           | Primeiro caractere do código de ingresso: `v` voluntário, `d` _walk-in_, outro = inscrição externa. |
| walk-in               | Participante criado na porta pelo editor de participantes (chave `d`).                |
| egress / `app-egress` | Redes Docker com rota para fora: `egress` (`tunnel`, `vpn`) e `app-egress` (só o `app`). |
| `IP_LIMIT_EXEMPT`     | Caminhos que pulam o limiter por IP (passe, status, questionário, webhook), com cobrança tardia sem sessão. |
| Stage A / Stage B     | Etapas da auditoria de outubro de 2026: A é a origem (código e contêineres); B é a configuração da Cloudflare. |
| conformance pass      | Passada que confere o host de produção contra o que o repositório afirma.             |
| `SCALE`               | Multiplicador da carga do teste; `SCALE=1` é uma sala de 500 participantes.           |
| ladder / rung         | Escada de cargas crescentes do teste; cada degrau é uma execução registrada.          |
| knee                  | Primeiro `SCALE` em que a latência servida estoura o limite: onde o host satura.      |
| load shedding         | Recusar o excesso com `503` e `Retry-After` para manter o resto rápido.               |

---

## 10. Índice de documentos

Todos em inglês, exceto este guia.

| Documento                                                               | Conteúdo                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`README.md`](../README.md)                                             | Visão geral, destaques de engenharia, arquitetura, como rodar.                     |
| [`docs/README.md`](./README.md)                                         | Índice das pastas de documentação.                                                 |
| [`security-overview.md`](./security/security-overview.md)                        | Postura de segurança por camada, riscos aceitos, pendências, lista de verificação pré-evento e histórico das auditorias. Os registros completos (e os IDs F-A…, N-A…, L…) estão na tag `archive/security-audits-2026`, no repositório de arquivo privado. |
| [`deployment.md`](./operations/deployment.md)                                      | Runbook de produção: primeiro deploy, verificação, dia do evento, rollback.        |
| [`fallback.md`](./operations/fallback.md)                                          | Servidor de contingência sem banco: contagem regressiva, avisos, página de encerramento. |
| [`event-day-support.md`](./operations/event-day-support.md)                      | Sessão de suporte no dia do evento: o que ela vê, remoção de identificadores, ensaio, _teardown_. |
| [`support/index.md`](./support/index.md)                                         | Instruções (_prompt_ de sistema) da sessão de suporte e seu mapa de documentos.    |
| [`standby.md`](./operations/standby.md)                                            | Warm standby: snapshots, failover, volta ao host principal, ensaio, teardown.      |
| [`incident-response.md`](./security/incident-response.md)                        | O que fazer diante de vazamento, segredo exposto ou host comprometido.             |
| [`admin-scopes.md`](./features/admin-scopes.md)                                  | O que cada escopo de administrador abre e quais conceder para cada função.         |
| [`imports.md`](./operations/imports.md)                                            | Importações CSV: lista de participantes e permissões de voluntários.               |
| [`container-containment.md`](./infrastructure/container-containment.md)                | Contenção de um contêiner comprometido: filtro de saída, isolamento, verificação.  |
| [`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md)                          | WAF, Challenge, Access — o registro para reconstruir o painel.                     |
| [`rate-limiting.md`](./performance/rate-limiting.md)                                | Princípios, catálogo de limiters, matriz de rotas, operação.                       |
| [`load-testing.md`](./performance/load-testing.md)                                  | Teste de carga: limiters, pilha, procedimento, registro e critérios das sessões.   |
| [`load-test-results.md`](./performance/load-test-results.md)                        | Todas as sessões registradas, por host e commit (gerado).                          |
| [`overload-behaviour.md`](./performance/overload-behaviour.md)                      | Sob sobrecarga: load shedding, cada timeout, prazo no cliente, re-toque seguro.    |
| [`db-cheatsheet.md`](./operations/db-cheatsheet.md)                                | Acesso ao psql, papéis, seed, inspeção.                                            |
| [`data-retention.md`](./security/data-retention.md)                              | Inventário de dados pessoais, expurgo e teardown.                                  |
| [`whatsapp-integration.md`](./features/whatsapp-integration.md)                  | Envio de códigos, recibos por webhook, configuração Meta e `.env`.                 |
| [`whatsapp-message-api-errors.md`](./features/whatsapp-message-api-errors.md)    | Referência dos códigos de erro da Cloud API.                                       |
| [`survey.md`](./features/survey.md)                                              | Questionário: quem responde, anonimato, controles, exportação.                     |
| [`redemption-options.md`](./features/redemption-options.md)                      | Valores aprovados de camiseta, camiseta de voluntário, almoço, lanche e bebida, por papel. |
| [`asset-delivery.md`](./infrastructure/asset-delivery.md)                              | Como CSS, fontes e JS chegam ao navegador.                                         |
| [`copy-management.md`](./development/copy-management.md)                            | Como os textos da interface são guardados, checados e traduzidos.                  |
| [`copy-inventory.md`](./development/copy-inventory.md)                              | Toda mensagem pt-BR com sua justificativa (gerado).                                |
| [`typescript-conventions.md`](./development/typescript-conventions.md)              | Quatro regras que existem porque a alternativa quebra em runtime.                  |
| [`demo-site.md`](./operations/demo-site.md)                                        | Demo pública em arquivos estáticos no Cloudflare Pages: o que serve, a API simulada no navegador, build, ensaio, domínio próprio. |
| [`static-site.md`](./operations/static-site.md)                                    | Página de encerramento em arquivos estáticos no Cloudflare Pages: build, ensaio, virada, regras da zona depois, desativação. |
| [`event-report.md`](./operations/event-report.md)                                  | Relatório pós-evento a partir das exportações do _teardown_: entradas, as duas formas de gerá-lo, abas, definições das métricas, privacidade. |
| [`brand.md`](./design/brand.md)                                                    | A marca PelicanPass: símbolo, logotipos, cores com contraste, fundo, tipografia e arquivos de ícone. |
| [`roadmap.md`](./development/roadmap.md)                                           | Eventos configuráveis: ajustes por evento no `/admin`, marca, modelos do WhatsApp, códigos de país, filtros da lista. |
| [`admin-export-plan.md`](./development/admin-export-plan.md)                       | Proposta, ainda não implementada: exportações em `/admin/exports`, CSV compartilhado, variantes anônima e pseudonimizada, auditoria de download. |
| [`admin-import-plan.md`](./development/admin-import-plan.md)                       | Proposta, ainda não implementada: importação de lista e permissões em `/admin/import`, prévia e depois confirmação, caminhos web e CLI. |
| [`qr-scanner-speed-plan.md`](./development/qr-scanner-speed-plan.md)               | Proposta, ainda não implementada: leitura de QR mais rápida, onde o tempo vai, detector nativo com _fallback_ WebAssembly, foco. |
| [`event-2026-10-17.md`](./reports/event-2026-10-17.md)                              | Relatório do evento de 17/10/2026: resultados, incidentes e lacunas nos dados.     |
