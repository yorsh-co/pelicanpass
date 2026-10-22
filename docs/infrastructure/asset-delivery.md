# Asset delivery

How the browser gets CSS, fonts and JavaScript, and the one thing that breaks
silently if you are not careful.

This closes `todo.md` §1 (`git show 5f0d61a:docs/todo.md`, in the archive), which analysed the font
problem and left one read-only sweep blocking the decision. That sweep is done — see
[The icon set is frozen](#the-icon-set-is-frozen).

---

## What changed, and why it mattered

Everything here is measured at the door: a queue of teenagers on their own
phones, on the most congested network the app will ever run on.

|                      | Before                            | After                    |
| -------------------- | --------------------------------- | ------------------------ |
| Check-in stylesheets | 22 requests, **serial**, 37,299 B | 2 requests, 18,767 B     |
| Fonts                | 2 extra origins, ~368,484 B       | same origin, 32,644 B    |
| Check-in page JS     | 390,600 B up front                | 20,152 B; ZXing deferred |

The stylesheet number is the one that is easy to underestimate. `main.css` was
served as authored, so its `@import`s resolved **serially** — the browser could
not discover the twenty-second file until the twenty-first had arrived. On a
fast connection that is invisible. On venue Wi-Fi it is the whole first paint.

---

## CSS

Authored under `src/web/public/css/`, bundled by `scripts/build-client.ts` into
`src/web/public/css/dist/`. **The `dist/` directory is generated and
git-ignored** — `npm run build` produces it, and nothing under it should ever be
edited.

Entries are listed in `CSS_ENTRIES` in the build script:

- `main.css` — the shell every document links
- one per page that declares its own stylesheet via `contentFor('styles')`

Page entries deliberately do **not** import `main.css`. They are additive
layers, and the document links both; importing the shell would inline a second
copy of it into every page bundle.

`external: ['/assets/*']` keeps font and image URLs pointing at `/assets` rather
than being copied into `dist/` and rewritten.

### Adding a stylesheet

A new page stylesheet needs an entry in `CSS_ENTRIES`. Without one it is never
built, and the `<link>` 404s — which is loud, so this fails safely.

---

## Venue map

The pass opens the venue map in a dialog (`components/pass.ejs`). There is one
map per locale, chosen by `VENUE_MAP_SRC` in `src/constants/venue-map.ts`:
`venue-map.svg` for pt-BR and `venue-map.en.svg` for English; `en-XA` uses
pt-BR's, as an SVG cannot be pseudo-translated. Each is a hand-written generic
sample map (entrance and check-in, auditorium and stage, food court, restrooms,
information desk) with system-font text: under 4 KB.

- **Format.** Use SVG for a line-drawn plan: it stays sharp under pinch-zoom and
  compresses to a few kilobytes. Use WebP only if the final art is illustrated or
  photographic.
- **Loading.** The `<img>` has its `src` at render and is not lazy, so the map is
  already cached when the dialog opens. Keep it that way; a lazy image inside a
  closed dialog would not load until someone opened it.
- **Replacing it.** Give each locale's new art a **new file name**, update
  `VENUE_MAP_SRC`, and update `pass.map.alt` in every catalog to describe the new
  map, all in the same commit. `/assets/images/` is served with a week's
  `max-age`, so reusing a name keeps the old map on phones that have already
  opened the pass.
- **Rounded corners** belong in the art: give its background `rx`. The frame's
  `border-radius` cannot reach the drawing, which `object-fit: contain` insets
  inside a transparent box.
- **Text inside an SVG** cannot use the page's web fonts when loaded through
  `<img>`. Outline it, or accept the system font.

---

## Fonts

All three are subsets, generated from Google's own subsetting endpoint and
committed under `src/web/public/assets/fonts/` with their licences (Libre
Franklin and Red Hat Mono are OFL, Material Symbols is Apache 2.0; all permit
redistribution and all want the notice alongside).

| File                            | Bytes  | Contents                                  |
| ------------------------------- | ------ | ----------------------------------------- |
| `libre-franklin-latin.woff2`    | 29,292 | Variable, weights 300–700, `latin` subset |
| `material-symbols-subset.woff2` | 5,876  | 39 icons                                  |
| `red-hat-mono-ticket.woff2`     | 10,768 | Variable, weights 400–700, `A–Z a–z 0–9`  |

`latin` is enough for pt-BR: it covers U+0000–00FF, which carries every
diacritic the copy uses (ã ç õ é â). `latin-ext` buys nothing here.

### Why Libre Franklin

The text face is also the face of the plain-text PelicanPass wordmark, so the
wordmark and the text beneath it read as one brand. Libre Franklin is the OFL
revival of Franklin Gothic, which is ITC/Monotype and cannot be served as a
webfont.

Swapping it in was cheaper than leaving it: Libre Franklin's `latin` subset is
**29,292 B against Inter's 48,256**, and Google emits a byte-identical
`unicode-range` for both, so that declaration did not change.

Two differences that are worth knowing before touching type here, both measured
against the shipped files rather than assumed:

- **The `wght` axis defaults to 100.** Libre Franklin's variable default
  instance is Thin. The `font-weight: 300 700` range in the `@font-face` is what
  keeps unstyled text readable — narrowing it is load-bearing, not cosmetic.
- **There is no `tnum` feature and the digits are proportional** (`0` is
  0.675 em, `1` is 0.438 em). Three `font-variant-numeric: tabular-nums`
  declarations were removed because they had become no-ops. Nothing is lost: an
  attendee only ever sees their own check-in number, so there is no second
  number for it to align with. Do not re-add it expecting alignment.

Metrics are otherwise close enough that the type scale was left alone —
x-height differs by 3% and the line box by 0.2%, which is why `--leading-tight`
and the `min-height: 1.5rem` line reservations still hold.

Self-hosting removed two DNS lookups and two TLS handshakes from a cold mobile
connection, and removed a hard runtime dependency on Google being reachable at
the moment someone is trying to get through the door. It also stopped handing
every attendee's IP to Google, which was an undeclared international transfer
under §12 of the privacy policy. The check-in page now makes exactly one
external request: the Cloudflare anti-bot widget, already disclosed on slide 7
of the privacy deck.

`src/app.ts` was tightened to match — `fontSrc` is now `'self'` only and
`styleSrc` is `'self'` plus the response nonce, with no `'unsafe-inline'`: no view
carries a `style` attribute, and the one `<style>` block takes the nonce. No CSS
declares a `data:` font, so that source went too.

### Why Red Hat Mono

Ticket codes are six characters of letters and digits, typed and read by
people, and `O` against `0` is the confusion that costs a queue time. Red Hat
Mono draws a **slashed zero** that stays distinct from `O` at 14px. JetBrains
Mono, IBM Plex Mono and Source Code Pro were considered and set aside: their
dotted zeros close up at small sizes.

It is applied to every place a ticket code is shown or typed, through
`--font-ticket`, and nowhere else. The subset is the 62 characters a code can
hold, and `unicode-range` limits the face to those, so the browser fetches the
file only when a code is rendered. Anything else in the same element falls
through to the system monospace.

Regenerate it with the same User-Agent as the icon subset below; the response
must say `format('woff2')`:

```bash
curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@400..700&text=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
# then fetch the fonts.gstatic.com URL from the returned @font-face
```

### The icon set is frozen

`material-symbols-subset.woff2` is built from **exactly these 39 icon names**:

```
add          admin_panel_settings archive     bug_report
call         cameraswitch         casino      check
checkroom    close                confirmation_number dark_mode
download     edit                 error       flashlight_on
group        how_to_reg           id_card     info
keyboard_arrow_down               keyboard_arrow_up
keyboard_double_arrow_right       light_mode  logout
map          menu                 monitoring  no_photography
person_search                     qr_code_scanner
redeem       refresh              send        unarchive
upload_file  visibility           visibility_off
warning
```

**"Built from" rather than "contains", and the difference is not pedantry.** The
subsetter also emits the *aliases* of what is requested, so the file holds more
ligatures than this list has names — 54 against 34 one revision back, 51 against
32 before it, and 47 against 29 before that. Requesting `add`, `archive` and
`unarchive` brought `save_alt` along uninvited; `visibility` brought
`remove_red_eye`, its own former name. So an icon absent from this list may still render,
and the rule below is about what may be **relied on**, not about what happens to
resolve today. Do not use a name that is not listed here.

`edit` was the eighteenth, added for the pass's name editor — the first time
this recipe was actually run. It cost 128 bytes, 3,584 to 3,712. `refresh` was
the nineteenth, for the button that retries a stalled band, and cost 80 more:
3,712 to 3,792. `keyboard_double_arrow_right` was the twentieth, for the thumb
on the staff card's slide-to-confirm rows, and cost **24**: 3,792 to 3,816.
`casino` was the twenty-first, for the raffle link on the volunteer pass, and
cost 60: 3,816 to 3,876. All four came in at a tenth of a kilobyte or less,
which is the number to weigh an icon against.

The admin shell's rail added eight at once — `admin_panel_settings`, `download`,
`group`, `menu`, `monitoring`, `person_search`, `redeem` and `upload_file` — for
1,176 bytes, 3,876 to 5,052. That is ~147 each rather than the ~70 the four
single additions averaged, because a batch brings ligature *letters* the file
did not already carry as well as the glyphs themselves.

**The attendees editor added three — `add`, `archive`, `unarchive` — and the file
got 8 bytes smaller: 5,052 to 5,044.** Four more glyph outlines (54 to 58) and
four more ligatures, for less file. All three needed only letters the subset
already carried, so nothing was added but outlines, and Brotli repacked the
result better than it had packed the old one.

**The volunteer lookup added two — `how_to_reg` and `visibility` — for 240
bytes: 5,044 to 5,284.** Two more outlines (58 to 60) and three more ligatures
(51 to 54), the third being the `remove_red_eye` alias nobody asked for. 120
bytes each, which is close to the batch-of-eight rate and nowhere near the
previous batch's −8.

**The scanner's camera switch added one — `cameraswitch` — for 172 bytes: 5,284
to 5,456.** Measured on 2026-09-11 against face `v371`, with the 34-name list
refetched first on the same face as the baseline (see the reproduction note
below — the committed file had been built on `v367`). Glyph and ligature counts
were not taken: `fontTools` is not installed and could not be, so this entry
records bytes only.

**The WhatsApp sender's nav entry added one — `send` — for 56 bytes: 5,448 to
5,504.** Measured on 2026-09-15 against face `v372`. The baseline is the 35-name
list refetched on that face, not the committed 5,456-byte file, which had been
built on `v371`; against the committed file the delta would read 48 and fold a
release into the glyph's cost. Bytes only, for the same reason as the entry above.
Nothing already in the set meant "send a message" — `call` is the phone and
`confirmation_number` is a ticket — so this one could not be avoided.

**The pass's venue map added one — `map` — for 96 bytes: 5,504 to 5,600.**
Measured on 2026-09-17 against face `v372`. The 36-name refetch reproduced the
committed file by hash (`sha256` fcb7976d…), so this time the committed file is
the baseline. The new file is `sha256` 6c74fb4e…. Bytes only, for the same
reason as the entries above.

**The admin sign-in's show-password toggle added one — `visibility_off` — for
188 bytes: 5,596 to 5,784.** Measured on 2026-10-02 against face `v375`. The
37-name refetch returned 5,596 bytes (`sha256` 08348d0b…) against the committed
5,600 (6c74fb4e…, `v372`), so the refetch is the baseline. The new file is
`sha256` 99842f7e…. The toggle shipped first without it and rendered the eye
followed by the literal `_off`: `visibility` resolved as a prefix and the rest
fell through as text. Every listed name was then confirmed to shape to a single
glyph with `fontkit` (`font.layout(name, ['liga']).glyphs.length === 1`), which
installs from npm where `fontTools` could not.

**The T-shirt desk's nav entry added one — `checkroom` — for 92 bytes: 5,784 to
5,876.** Measured on 2026-10-06 against face `v375`. The 38-name refetch
reproduced the committed file by hash (`sha256` 99842f7e…), so the committed
file is the baseline. The new file is `sha256` 774d0aee…. Bytes only, for the
same reason as the entries above. It serves the rail entry and the record page's
hand-over button.

**Take the spread as the end of the per-icon cost model, not as a rate to budget
from.** Single additions cost 128, 80, 24 and 60 bytes; a batch of eight cost
~147 each; a batch of three cost **less than nothing**; a batch of two cost 120
each; single additions cost 172, 56, 96, 188 and 92. The number is unpredictable at this scale
because it is dominated by compression, not by outlines. Measure each time.

**An icon outside the list above renders as its ligature text** — the literal
word `qr_code_scanner` in the UI — silently, with no console error, visible only
by looking at a browser. An alias the subsetter happened to include is the one
exception, and relying on that is relying on Google's alias table not changing.

#### Validate the names before fetching

Google **drops an icon name it does not recognise** rather than failing, so a
typo produces a working font that is missing a glyph. Check every name against
the canonical list first:

```bash
curl -s "https://fonts.google.com/metadata/icons?incomplete=1&key=material_symbols"
# JSON behind a `)]}'` prefix line; 4,239 names under .icons[].name on 2026-09-15
```

**This replaces the differential check this section used to recommend**, which
does not work. That advice was: refetch the previous list, confirm it reproduces
the committed file byte for byte, then confirm the new list differs — on the
theory that an unresolved name leaves the build unchanged. Measured against the
live endpoint, it does not:

- an unknown name returns HTTP 200 and a complete stylesheet, with no error;
- the `kit` token in the URL encodes the names *requested*, so it changes for an
  unrecognised name too;
- and the file itself grows. `check` alone is 944 bytes; `check,bogus_icon_xyz`
  is 1,496, because the subsetter embeds the Latin letters that spell each
  ligature whether or not the icon resolves.

So the build differs either way and the difference proves nothing. Validating
names up front removes the failure mode instead of trying to detect it after.

The refetch is still worth running as a **pipeline** check — that the endpoint,
the User-Agent and the face version are what they were. Run it *before* fetching
the new list: it is what makes the byte delta attributable to the glyphs rather
than to a face that moved underneath you.

Reproduced three times, all on 2026-08-25 and all against face `v367`: the
21-name list reproduced the committed 3,876-byte file, the 29-name list
reproduced the 5,052-byte one byte for byte (`sha256` 266766b8…), and the
32-name list reproduced the 5,044-byte one (`sha256` 064f578a…). The face has
not moved across any of them, which is what makes each recorded delta
attributable to the glyphs rather than to a release underneath them.

**On 2026-09-11 the face had moved to `v371`, and the check caught it.** The
34-name list returned 5,284 bytes — the committed size exactly — but a different
`sha256` (3488931e… against the committed cf26f387…). Same names, same byte
count, different outlines. That refetched file, not the committed one, is the
baseline the `cameraswitch` delta above is measured from; comparing against the
`v367` build would have folded a release into the glyph's cost. **A size match
is not a reproduction — compare hashes.**

**On 2026-09-15 it had moved again, to `v372`, and this time the size moved too.**
The 35-name list returned 5,448 bytes (`sha256` 93e8044b…) against the committed
5,456 (94e07286…). Eight bytes smaller for the same names — a release, not a
glyph — which is the baseline the `send` delta above is measured from. Two face
releases in four days is the rate to expect: run the refetch every time, even
when the last run was recent.

Adding one means regenerating the subset:

```bash
ICONS=add,admin_panel_settings,archive,bug_report,call,cameraswitch,casino,\
check,checkroom,close,confirmation_number,dark_mode,download,edit,error,flashlight_on,\
group,how_to_reg,id_card,info,keyboard_arrow_down,keyboard_arrow_up,\
keyboard_double_arrow_right,light_mode,logout,map,menu,monitoring,no_photography,\
person_search,qr_code_scanner,redeem,refresh,send,unarchive,upload_file,\
visibility,visibility_off,warning,your_new_icon

curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&icon_names=$ICONS"
# then fetch the fonts.gstatic.com URL from the returned @font-face
```

A browser User-Agent is required: Google serves TTF to unrecognised clients.
**The whole string matters, not just the `Chrome/120` token** — the shorter UA
this section used to carry returns `format('truetype')`, which is 3× the bytes
and drops the `liga`/antialiasing declarations from the CSS.

The set is closed and statically provable, which is what `todo.md` §1 needed
confirmed before subsetting was safe. Icons come from these places, and nowhere
else:

- ligature text in `src/web/views/**/*.ejs`
- the `icon` field of each entry in `src/constants/admin-nav.ts`, rendered into
  the admin rail
- `ICONS` in `client/modules/ui/toast.ts`
- the two arrows in `client/pages/attendee/checkin/ui/table-toggle.ts`
- the slide thumb's two glyphs in `client/pages/attendee/staff/index.ts`
- the menu toggle's `menu`/`close` in `client/pages/admin/shell/index.ts`
- the theme toggle's `dark_mode`/`light_mode` in `client/theme/theme.ts`
- the health indicator's `check`/`error` in `client/pages/admin/metrics/index.ts`
- the reset button's `refresh` in `client/pages/attendee/raffle/index.ts`
- the show-password toggle's `visibility`/`visibility_off` in
  `client/pages/admin/login/index.ts`

This list said "exactly four places" until 2026-09-15. The admin shell, the
theme toggle, the metrics panel and the raffle had each added a source without
adding it here — every name they use was already in the set, so nothing rendered
wrongly, but the claim above was not true while the list was short. **A new
source of icon names belongs in this list in the same commit that adds it.**

A fourth source used to exist — `content: 'check'` on `.check::after` in
`css/pages/attendee/checkin.css` — and it was **broken the whole time it
shipped**. `font-family` and `font-feature-settings: 'liga'` live only on the
`.material-symbols-outlined` class, which that pseudo-element never carried, so
it rendered the literal word `check`. The success screen now uses a real
ligature span. Prefer a span: a `content` string cannot inherit the class that
makes the ligature resolve, which is exactly how this went unnoticed.

`toast.ts` accepts an arbitrary `options.icon`, but **no call site passes one**.
If one ever does, the set stops being provable and this subset stops being safe.

`font-display: block` on the icon face is deliberate, against `swap` on the text
face: an un-swapped icon shows the word `logout` in the top bar, which is worse
than a brief blank.

---

## JavaScript

Bundled from `src/web/client` to `src/web/public/js`, one bundle per page entry,
also git-ignored.

`splitting: true` is what lets `await import('html5-qrcode')` in
`client/modules/qr.ts` land in its own chunk instead of being inlined. That one
import is 95% of the check-in page's JavaScript — roughly 5,500 lines of ZXing —
and nobody typing a ticket code needs it. On `/checkin` it is fetched when
someone taps "Ativar câmera".

**`/staff` is the exception**, and prefetches it after the boot screen through
`prefetchScanner()`. Both halves of the deferral's reasoning are about the
check-in page: hundreds of attendees loading it on the worst network the app
sees, many of whom never open a camera. Neither holds for a few dozen volunteer
phones where scanning is the entire job, and where the deferral instead bills
the first scan of a shift to whoever is standing at the counter.

Chunks land in `js/chunks/` and are referenced relatively, so they resolve
under `/js/` without configuration.
