# Static Closing Site

The closing page, `/privacy` and `/terms` as plain files on Cloudflare Pages. It keeps the public
hostname answering after the event with no server, no tunnel and no machine left running, so the
production host and the fallback can both be shut down.

For the server that does this while the stack is still being restarted, see
[`fallback.md`](./fallback.md).

---

## 1. What it serves

| Path                 | Answer                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| `/privacy`, `/terms` | The same notices the live app renders, as `privacy.html` and `terms.html` |
| `/site.webmanifest`  | The live app's manifest, served with its content type by `_headers`       |
| Static files         | Only the stylesheets, bundle, fonts and images those pages reference      |
| Every other path     | The closing page (`index.html`), because there is no `404.html`           |

`npm run build:static` renders the closing page and the two notices from the standalone fallback with
the event closed, so the copy is the thank-you page of [`fallback.md`](./fallback.md) § 5. Pages'
clean-URL rules serve `privacy.html` at `/privacy` and `terms.html` at `/terms`.

There is no `404.html`. Pages therefore answers every unknown path with `index.html`, which is what
sends an old `/checkin?t=…` link, a `/pass` link or a printed QR code to the closing page.

`_headers` carries the headers the app sent: a CSP that authorises the inline theme script by its
sha256 hash (a static file cannot carry a per-request nonce), the Permissions-Policy, the
helmet-equivalent headers and the manifest content type.

### What differs from the fallback

- **`/api/**` no longer answers `410 EVENT_CLOSED` JSON.** The fallback did; on Pages the same request
  gets the closing HTML. This is accepted: there is no server any more, and nothing is left to call
  the API.
- **There is no server.** No container, no tunnel, no healthcheck and no `.env` to keep in step with
  production.
- **`no-store` is gone.** The fallback sent it so a phone or Cloudflare would not keep the curtain
  once the live app was back. Nothing comes back now, so Pages' default caching applies.
- **The `<title>` and the footer's copyright year are fixed at build time.**

## 2. Build

Build from **the first release tag that includes `build:static`**, or a later one, after a clean
install. The pages are rendered from that checkout's views and copy, so check that its closing,
privacy and terms text matches what production last served:

```sh
git checkout <release tag>
npm ci
APP_TITLE='<production title>' npm run build:static
```

`<title>` comes from `APP_TITLE`, which defaults to `PelicanPass`. Copy the value from the production
`.env`; a build without it ships the default.

The output is `dist/static/`: `index.html`, `privacy.html`, `terms.html`, `site.webmanifest`,
`_headers` and the assets. `dist/static` is git-ignored.

## 3. Rehearse

Deploy with Direct Upload. There is no Git-integrated Pages build.

```sh
npx wrangler login                                        # first time only
npx wrangler pages deploy dist/static --project-name <name>
```

The first run creates the project. Open `https://<name>.pages.dev` **on a phone** and check:

1. `/` shows the closing page.
2. `/privacy` and `/terms` show the notices.
3. An unknown path such as `/checkin?t=x` shows the closing page.
4. The theme toggle switches between light and dark.

Nothing is public until the hostname is moved in §4, so this can be done days ahead.

## 4. Cut over

1. **Remove the public hostname** (`SITE_HOST`) from whichever tunnel serves it, the production
   tunnel or the fallback's, in Zero Trust → Networks → Tunnels. This deletes its DNS record.
2. **Add `SITE_HOST` to the Pages project** under Custom domains. Pages creates the CNAME itself.
   Expect a short gap between the two steps, during which the hostname does not resolve.
3. **Confirm the closing page on the public URL**, as in §3.

The hostname and zone are unchanged, so the zone's rules keep applying until they are changed in §5.

## 5. Zone rules after the cutover

The rules in [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) § _Custom rules_ were
written for a live app. Against a static site:

- **Rule 2, the site-wide Managed Challenge: disable it.** It would challenge every visitor to a
  thank-you page, and the manifest fetch no longer needs a `cf_clearance`.
- **Rules 3 and 4, the check-in API method gate and the WhatsApp receipt callback: delete them.**
  They guard paths that no longer exist.
- **Rule 1, the non-Brazilian block, is the owner's decision.** Keeping it limits the page to
  visitors in Brazil; removing it shows the page to everyone.
- **Delete the Cloudflare Access application** for the admin surface
  ([`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) § _Cloudflare Access_). `/admin`
  no longer exists, so the policy protects nothing.

## 6. Decommission

Once the closing page answers from Pages:

1. Delete the production tunnel and the fallback tunnel in Zero Trust → Networks → Tunnels.
2. Shut the machines down.

Do this after the teardown in [`deployment.md`](./deployment.md#teardown) has exported what is
being kept and destroyed the volumes. The static site holds none of it: it is built from the
repository and carries no attendee data. What the exports and any dumps may keep is in
[`data-retention.md`](../security/data-retention.md).

## 7. Updating the site later

Rebuild from a release tag and deploy again (§2, then `wrangler pages deploy`). A build from any other
checkout publishes that checkout's copy.

The privacy and terms text is the live app's. It speaks in the present tense about a running
service, which stops being true once the servers are gone. Review its wording before relying on it
long term.
