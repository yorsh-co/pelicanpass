# Brand

The PelicanPass identity: the mark, the wordmarks, the colours and the type, and the files that
carry them. Everything needed to redraw an asset is on this page.

An event deployed with its own branding replaces these files, not this guide: the guide describes the
default every deployment ships with.

---

## The mark: the Pelican P

A capital **P** whose bowl is the head and whose stem is the neck; the beak and its pouch are the one
accent. It is three primitives — a rounded bar, a circle and one curved triangle — so it holds at
16 px, and the construction below is the source every icon is rendered from.

```svg
<!-- 100 × 100 design grid. Paint order matters: the head covers the root of the beak and the neck's rounded top. -->
<g transform="translate(50 50) scale(S) translate(-57 -49)">
  <rect x="22" y="24" width="16" height="64" rx="8" fill="#FFFFFF" />  <!-- neck -->
  <path d="M56 17 L92 40 Q72 66 44 50 Z" fill="#F5A524" />            <!-- beak and pouch -->
  <circle cx="42" cy="30" r="20" fill="#FFFFFF" />                     <!-- head -->
  <circle cx="46" cy="25" r="3.6" fill="#0E4A5A" />                    <!-- eye -->
</g>
```

`translate(-57 -49)` moves the glyph's optical centre onto the grid's centre; `S` is the only value
that changes between uses.

| Use                    | Ground                                  | `S`  | Notes                                        |
| ---------------------- | --------------------------------------- | ---- | -------------------------------------------- |
| Lockup, beside text    | none                                    | 0.92 |                                              |
| App icon, 32 px and up | Harbour tile, `rx="22"` on the 100 grid | 0.72 |                                              |
| Favicon at 32 px       | Harbour tile, `rx="22"`                 | 0.78 | Slightly larger to survive the downsample    |
| Favicon at 16 px       | Harbour tile, `rx="22"`                 | 0.82 | No eye: at 16 px it is a stray pixel         |
| Maskable icon          | Harbour, full bleed, no corner radius   | 0.64 | Whole glyph inside the 40 % safe-zone radius |
| `apple-touch-icon`     | Harbour, full bleed, no corner radius   | 0.72 | iOS applies its own mask                     |

Colourways:

- **On Harbour** (default): neck and head white, beak Pouch, eye Harbour.
- **On light surfaces**: neck and head Harbour, beak Pouch, eye the surface colour.
- **Single colour**: every shape in one ink, the eye cut out to the surface.

Do not stroke, rotate, add effects to or recolour the mark beyond these three.

## Wordmarks

**Pelican** in Libre Franklin 800 and **Pass** in Libre Franklin 400, set solid with
`letter-spacing: -0.035em`. The weight change separates the two words on its own, so the wordmark
reads in a single colour; colour, where it is used, only reinforces it.

| File                                        | Size (viewBox) | Content                              | Colour                                                          |
| ------------------------------------------- | -------------- | ------------------------------------ | --------------------------------------------------------------- |
| `assets/images/logo/wordmark-primary.svg`   | 506 × 121      | Mark (`S` 0.92) + wordmark, one line | Two-tone: white "Pelican" and mark, Shallows "Pass", Pouch beak |
| `assets/images/logo/wordmark-secondary.svg` | 341 × 75       | Wordmark only                        | Single colour; drawn as a CSS mask, so it takes `currentColor`  |

Both are outlined paths, never live `<text>`: an `<img>` and a CSS mask cannot load the page's web
font. The viewBox sizes are load-bearing — `css/components/wordmark.css` hard-codes
`aspect-ratio: 341 / 75`, and a different ratio letterboxes without any visible error.

On a light surface the primary lockup is Harbour throughout with a Pouch beak; Shallows is a
dark-ground colour only.

`docs/images/banner.svg` is the README header: 1280 × 320, the primary lockup centred on a Harbour
rounded rectangle (`rx` 22 % of the height), so the on-Harbour colourway reads on light and dark
pages. It is documentation, not a web asset, and is built from the primary wordmark above.

## Colours

| Role               | Name      | Hex       | Used for                                                |
| ------------------ | --------- | --------- | ------------------------------------------------------- |
| Primary            | Harbour   | `#0E4A5A` | Brand backdrop, icon tile, the mark on light surfaces   |
| Primary, deep      | Abyss     | `#072A33` | End of the backdrop gradient; text on Pouch             |
| Secondary          | Pouch     | `#F5A524` | The beak, boot-screen motifs, accents on Harbour        |
| Muted ink on brand | Shallows  | `#CFE6E8` | "Pass" in the primary wordmark; `--text-on-brand-muted` |
| Pouch, as text     | Pouch Ink | `#9A5B00` | Pouch at text weight on light surfaces                  |

The neutral canvases are unchanged: `#FAFAFC` light and `#0A0A11` dark, as in `css/base/variables.css`
and the layouts' `theme-color` metas.

### In the interface

The accent tokens in `css/base/variables.css` carry the palette into the app's own screens. Harbour is
2:1 on the dark canvas, so the dark theme's accent is Pouch. The hover and soft values are derived for
the interface and are not brand colours.

| Token                   | Light               | Dark                |
| ----------------------- | ------------------- | ------------------- |
| `--accent`              | Harbour `#0E4A5A`   | Pouch `#F5A524`     |
| `--accent-hover`        | Abyss `#072A33`     | `#D98B12`           |
| `--accent-text`         | `#FFFFFF`           | Abyss `#072A33`     |
| `--accent-soft`         | `#E3EFF1`           | `#2A1E0A`           |
| `--brand-accent`        | Pouch `#F5A524`     | Pouch `#F5A524`     |
| `--text-on-brand-accent`| Abyss `#072A33`     | Abyss `#072A33`     |

`--brand-accent` is for controls on the brand backdrop, which is the same in both themes.

### Contrast

WCAG 2.x ratios, computed from the hex values above.

| Foreground | Background | Ratio  | Verdict                        |
| ---------- | ---------- | ------ | ------------------------------ |
| `#FFFFFF`  | Harbour    | 9.8:1  | AA and AAA, any size           |
| Shallows   | Harbour    | 7.5:1  | AA and AAA, any size           |
| Pouch      | Harbour    | 4.8:1  | AA, any size                   |
| `#FFFFFF`  | Abyss      | 15.1:1 | AA and AAA, any size           |
| Shallows   | Abyss      | 11.6:1 | AA and AAA, any size           |
| Abyss      | Pouch      | 7.4:1  | AA and AAA, any size           |
| Harbour    | `#FAFAFC`  | 9.4:1  | AA and AAA, any size           |
| Pouch Ink  | `#FAFAFC`  | 5.2:1  | AA, any size                   |
| Pouch      | `#FFFFFF`  | 2.0:1  | **Fails**: never text on light |

Every text pairing on the brand backdrop clears 4.5:1 across the whole Harbour-to-Abyss gradient,
because both ends are listed above.

## Brand backdrop

`--brand-backdrop` is a vertical gradient, Harbour at the top to Abyss at the bottom
(`#0E4A5A 0%`, `#0B3B48 60%`, `#072A33 100%`), shipped as `assets/images/bg/bg.png` and `bg.webp` at
1080 × 1920 with the same gradient as the CSS fallback layer under it. It appears only on the boot
screen and the reward surfaces (the success card and the pass), as before.

## Motifs

Ripples rather than ornaments: open rings in brand colours, white-filled where the existing CSS
expects white.

| File                                       | Canvas    | Drawing                                                                                |
| ------------------------------------------ | --------- | -------------------------------------------------------------------------------------- |
| `assets/images/motifs/star-sm.svg`         | 155 × 155 | One ring, `r="70"`, Pouch stroke                                                       |
| `assets/images/motifs/star-with-discs.svg` | 615 × 615 | Three concentric rings, `r` 300 / 230 / 160, Shallows stroke at 10 / 14 / 18 % opacity |

The file names predate the identity and are kept so `components/boot-screen.ejs` does not change.

## Typography

| Face           | Weights  | Used for                                  |
| -------------- | -------- | ----------------------------------------- |
| Libre Franklin | 800, 400 | Wordmark; 300–700 for headings and body   |
| Red Hat Mono   | 500      | Pass codes and other machine-read strings |

Both are already self-hosted (`assets/fonts/`); the identity adds no font. See
[`asset-delivery.md`](../infrastructure/asset-delivery.md) for the subsets.

## Icon files

All rendered from the mark's construction above, in Harbour and Pouch.

| File                                       | Format | Size                | Ground               |
| ------------------------------------------ | ------ | ------------------- | -------------------- |
| `assets/images/icon/favicon.svg`           | SVG    | 1024 × 1024 viewBox | Tile, `S` 0.72       |
| `assets/images/icon/icon-master-1024.png`  | PNG    | 1024                | Tile, `S` 0.72       |
| `assets/images/icon/icon-512.png`          | PNG    | 512                 | Tile, `S` 0.72       |
| `assets/images/icon/icon-512-maskable.png` | PNG    | 512                 | Full bleed, `S` 0.64 |
| `assets/images/icon/icon-192.png`          | PNG    | 192                 | Tile, `S` 0.72       |
| `assets/images/icon/apple-touch-icon.png`  | PNG    | 180                 | Full bleed, `S` 0.72 |
| `assets/images/icon/favicon-32x32.png`     | PNG    | 32                  | Tile, `S` 0.78       |
| `favicon.ico`                              | ICO    | 48 and 32           | Tile, `S` 0.78       |

Paths are relative to `src/web/public/`. The 16 px rendering (`S` 0.82, no eye) is the reference for
anything drawn at that size; no file ships at 16 px.

## Regenerating the assets

`npm run brand:build` redraws every file in the tables above into `src/web/public/`. The source
font, Libre Franklin, and its licence live in `scripts/brand/fonts/`. This guide's numbers live in
`scripts/brand/palette.ts` and the construction in `scripts/brand/mark.ts`, so change the guide and
the script together.
