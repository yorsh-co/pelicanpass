# Static Demo Site

A public demo of PelicanPass as plain files on Cloudflare Pages, at `pelicanpass.demos.yorsh.co`. It has
no server, database, cache or Worker. The pages are rendered at build time from the real views, and a
mock API in the browser stands in for the backend, so check-in, the pass, staff redemption and the
raffle work against fictional data held in the visitor's tab.

For the closing page that replaces the live app after the event, see
[`static-site.md`](./static-site.md). The build follows the same pattern.

---

## 1. What it serves

| Path                                                    | Answer                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/`                                                     | `302` to `/checkin`                                                                      |
| `/checkin`                                              | The check-in flow, in the event-open state                                               |
| `/pass`, `/pass-volunteer`                              | The participant pass and the volunteer pass; the mock sends each session to its own      |
| `/staff`                                                | The staff scan and redeem screen                                                         |
| `/raffle`                                               | The raffle draw                                                                          |
| `/privacy`, `/terms`                                    | The notices, as `privacy.html` and `terms.html`                                          |
| `/admin`                                                | The admin home                                                                           |
| `/admin/metrics`, `/admin/pass`, `/admin/attendees`     | Admin pages, one file each in `admin/`                                                   |
| `/admin/lookup`, `/admin/redemptions`, `/admin/tshirts` | Admin pages, one file each in `admin/`                                                   |
| `/admin/volunteers`, `/admin/survey`, `/admin/whatsapp` | Admin pages, one file each in `admin/`                                                   |
| `/admin/lookup/record`, `/admin/redemptions/record`     | `200` rewrite to the one detail fixture (`lookup-detail`, `redemptions-detail`)          |
| `/admin/tshirts/record`, `/admin/volunteers/record`     | `200` rewrite to the one detail fixture (`tshirts-detail`, `volunteers-detail`)          |
| `/admin/attendees/new`, `/admin/attendees/edit`         | `200` rewrite to `/admin/attendees`                                                      |
| `/admin/survey/export.csv`                              | `200` rewrite to `/admin/survey`; the CSV itself is not built                            |
| `/admin/login`                                          | `302` to `/admin`                                                                        |
| `/robots.txt`                                           | `Disallow: /`                                                                            |
| `/site.webmanifest`                                     | The app's manifest, served with its content type by `_headers`                           |
| Static files                                            | Only the stylesheets, bundles, fonts and images the pages reference, plus `css/demo.css` |
| Every other path                                        | `404.html`, the app's not-found page with a link back to `/`                             |

Every response carries `X-Robots-Tag: noindex`. Every page opens with a banner that says the event and
data are fictional, lists the demo codes and links to the read-only `/admin` panel and the repository.
The banner is in Portuguese or English: it follows the browser's language, and its toggle button saves
the visitor's choice in `localStorage`, so it holds across pages and resets. The rest of the page stays
in Portuguese.

## 2. How it works

### Rendering

`npm run build:demo` renders the view fixtures in `src/web/views/fixtures.ts` through the real Express
view engine, the same ones the view snapshot suite asserts, plus the `DEMO_CASES` that only the demo
renders (the healthy metrics page, the demo roster and pass pages, and the plain 404). Each page is
rendered with a per-render nonce, which is then stripped; its hash goes into the generated `_headers`.
The policy is the production CSP from `src/config/csp.ts` with nonces swapped for hashes. Every page
renders in the event-open state with no countdown, because a countdown baked into static files would go
stale. The mock bundle (`js/demo/mock-api.js`) is injected as the first script of every page. It is
built from `src/web/client/demo/`, which no production entry point imports, so `npm run build` never
ships it.

### The mock API

The mock replaces `window.fetch` for same-origin `/api/v1` requests, and `navigator.sendBeacon` for
client error reports, which it drops. It adds a short random latency so the pending states show.

- **State is per tab**, in `sessionStorage`, with an in-memory copy when storage is unavailable. The
  banner's reset button clears it (not the banner's language choice). Nothing is shared between
  visitors or kept after the tab closes.
- **The roster is fictional**: 15 participants and 5 volunteers. 12 participants are already checked in,
  which gives the raffle a pool and `/staff` people to serve before the visitor does anything.
- **Demo ticket codes** are `DEMO_TICKET_CODES` in `src/web/client/demo/roster.ts`: `k7m2q9` and
  `p4x8c3` for participants, `v2n5r8` for the volunteer. They start unchecked-in. The banner prints them.
- **The verification code** is `DEMO_VERIFICATION_CODE` (`1234`), the same for every attendee.
- **Wrong codes** return the production error codes. After five wrong ticket or verification codes (ten
  for the QR step) the session requires a captcha, as in production. The widget is Cloudflare's
  always-pass Turnstile test key, so it solves itself.
- **Presence confirms immediately.** Production holds it for an administrator to confirm. Admin screens
  are read-only here and a visitor has one device.
- **The QR step** accepts the token on the fictional venue poster, or the "already checked in with a
  volunteer" link on the page.
- **`/staff`** takes a demo ticket code instead of the camera, which a single-device visitor can use.
  Redemptions show on the pass at its next poll.
- **`/raffle`** draws from the checked-in participants. Reset empties the draws.

### Admin is read-only

The admin pages render fixture data. Any non-`GET` form under `/admin` is cancelled and shows the
"disabled in the demo" notice in the toast component, and an admin `fetch` mutation is refused with the
same notice. Logout goes back to `/admin`. The metrics dashboard polls the mock's fixture figures,
with a little deterministic movement so it does not look frozen.

### The coverage test

`scripts/demo/build.test.ts` scans every shipped script for `/api/v1/` paths, including template
literals, and fails the build when one has neither a mock handler nor an explicit refusal. A client
change that adds an endpoint therefore breaks `npm test` until the mock covers it. The same suite checks
that no nonce remains, every inline script and style hash is in the policy, every local reference
resolves to a file or a `_redirects` rule, and every page carries the banner.

### What differs from production

- **There is no server.** No session cookie, no database and no WhatsApp: the "session" is the mock's
  `sessionStorage` entry, and ticket codes are the three above.
- **Presence confirms at once**, as above.
- **Admin cannot change anything.** Forms and mutations show the notice, and CSV import, export and
  WhatsApp sending are not built.
- **Detail pages are single fixtures.** Any `/admin/lookup/record` shows the same person, whatever the
  query string says.
- **The clock is fixed.** Pages render in the event-open state and show no countdown.
- **Locale and data.** Only pt-BR, which is what production ships, and only fictional attendees.
- **The `/checkin?t=…` entry token is not checked.** The query keeps working client-side; the server
  handling is skipped.
- **Analytics and logging.** Nothing is recorded: error reports are dropped.

## 3. Build

```sh
git checkout <release tag>
npm ci
npm run build:demo
```

`build:demo` runs `npm run build`, then `scripts/demo/build.ts`. The output is `dist/demo/`, which is
git-ignored: the pages, `admin/`, `404.html`, `_headers`, `_redirects`, `robots.txt`,
`site.webmanifest`, `css/demo.css`, `js/demo/mock-api.js` and the assets they reference. `--out <dir>`
writes elsewhere.

### Regenerating README screenshots

```sh
npm run build:demo
npm run docs:screenshots
```

`scripts/docs/screenshots.ts` serves `dist/demo/` on a local port, drives the real pages in Chromium
and writes nine compressed PNGs to `docs/images/screenshots/`, the ones `README.md` shows: the check-in
ticket and verification steps, the participant pass front and back, the volunteer pass, `/staff` after
a typed code, `/raffle` after one draw, and `/admin/redemptions` and `/admin/metrics`. Phone screens
are 390×844 at 2×, admin screens 1440×900. The demo banner is hidden, and the clock, time zone,
`Math.random` and motion are fixed so a rerun differs by at most a few antialiased pixels. `--out <dir>`
writes elsewhere.

The browser is the one in Playwright's cache (`~/.cache/ms-playwright`), found by `playwright-core`
at the revision it pins; the script downloads nothing. Where the cache is empty, run
`npx playwright-core install chromium` once.

## 4. Rehearse

Deploy with Direct Upload. There is no Git-integrated Pages build, which keeps build secrets out of
Cloudflare.

```sh
npx wrangler login                                                    # first time only
npx wrangler pages deploy dist/demo --project-name pelicanpass-demo
```

The first run creates the project. Open `https://pelicanpass-demo.pages.dev` **on a phone** and check:

1. `/` redirects to `/checkin`, and the banner lists the demo codes and links to `/admin`.
2. Check in with a participant code, the verification code and the QR step. The pass shows a check-in
   number, the QR code and a nickname field.
3. Change the nickname and reload; it persists in the tab.
4. In a second tab, open `/staff`, type the same ticket code and redeem an item. The pass shows the
   redemption at its next poll.
5. `/raffle` draws a number from the checked-in pool, and its reset clears the draws.
6. Reset the demo from the banner and check in again with the volunteer code. The volunteer pass opens.
7. Switch the banner to English, then open another page. The banner stays in English.
8. Press any button or submit any form in `/admin`: it shows the demo notice and changes nothing on
   reload.
9. `/admin/metrics` reports healthy.
10. `/admin` **and** `/admin/metrics` both resolve. `admin.html` sits beside an `admin/` folder, and
   Pages' clean-URL handling of a file and a folder with the same name is the one routing risk.
11. An unknown path such as `/nope` shows the 404 page.
12. The theme toggle switches between light and dark.

Nothing is public until the custom domain is added in §5, so this can be done days ahead.

## 5. Custom domain

1. In the Pages project, under Custom domains, add `pelicanpass.demos.yorsh.co`. Pages creates the
   CNAME itself when the zone is on Cloudflare.
2. **Confirm the certificate issues for the nested hostname.** The status must reach Active and
   `https://pelicanpass.demos.yorsh.co` must load without a certificate warning. The hostname is two levels below the
   apex, which is the case most likely to stall.
3. If it does not issue, remove it and add `pelicanpass-demo.yorsh.co` instead. Update the README link
   to match.
4. Repeat the §4 checklist on the public hostname.

### Zone rules

The rules in [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) § _Custom rules_ have no
hostname condition: rule 2 is documented as covering every hostname on the zone, and rules 1, 3 and 4
match on country or path alone. If `yorsh.co` carries those rules, they apply to the demo hostname as
well:

- **Rule 1 blocks visitors outside Brazil** and **rule 2 puts a Managed Challenge in front of every
  visitor.** Either would hide a public demo. Scope them to exclude the demo hostname, or skip them
  for it, before announcing the link.
- **Rules 3 and 4 match `/api/v1/` paths** that the demo never requests: the mock answers in the
  browser, and no `/api/v1` call leaves the page.

Which zone the rules live on is a Cloudflare dashboard question this repository cannot answer. Check
Security → WAF → Custom rules for the zone that holds `demos.yorsh.co`.

## 6. Updating the demo

Rebuild from a release tag and deploy again (§3, then `wrangler pages deploy`). A build from any other
checkout publishes that checkout's views and mock. Check §4 again after a change to check-in, the pass
or the staff screen: the coverage test catches a new endpoint, but a behavioural change that keeps the
same response shape, such as a new step order, is only caught by the phone rehearsal.
