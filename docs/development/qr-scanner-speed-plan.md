# QR Scanner Speed — Implementation Plan

**Status:** proposed. Nothing below is built yet. The decoder approach is
decided: html5-qrcode is replaced (Phase 2).

Volunteers reported that the check-in and `/staff` scanner can be slow to
recognise a code on some phones, while a Play Store scanner on the same phone
reads it at once. On other phones it is already fast. This plan closes as much
of that gap as a browser allows.

## Starting point

The scanner is `html5-qrcode` 2.3.8, the last release, now unmaintained. It is
loaded on demand from `modules/qr/qr.ts` and started with `fps: 10`, a 1280×720
`ideal` stream and a `qrbox` sized by `modules/qr/decode-box.ts`. No
`formatsToSupport`, `disableFlip` or `experimentalFeatures` is passed.

Reading the installed library (`node_modules/html5-qrcode/esm/`) shows where the
time goes:

1. **The native detector is already on, but it only gets half the frames.**
   `getUseBarCodeDetectorIfSupported` defaults to `true`, so on Chrome for
   Android `BarcodeDetector` is the primary decoder. But
   `Html5QrcodeShim.getDecoder` (`code-decoder.js`) **alternates** between it
   and the ZXing JavaScript port on every frame. Every second frame goes
   through ZXing JS on the main thread, the slow path we want to avoid.
2. **Each failed frame is decoded twice.** With `disableFlip` unset,
   `foreverScan` (`html5-qrcode.js`) mirrors the canvas and decodes it again
   whenever a frame fails. While the code is being aimed, nearly every frame
   fails, so this doubles the cost. The raw frames are never mirrored: our
   front-camera mirroring is CSS only (`data-facing`).
3. **ZXing tries every barcode format.** Without `formatsToSupport`, each frame
   is tried as QR, the 1D symbologies, Aztec, PDF417 and so on.
4. **The loop runs in sequence and is throttled.** The next frame is
   scheduled `1000 / fps` ms _after_ the previous decode settles. At
   `fps: 10`, a phone that takes 120 ms per ZXing pass manages about four
   attempts a second, half of them ZXing.
5. **The 720p stream is downscaled before decoding.** The decode canvas is
   sized to `qrRegion` in **CSS pixels** (`createCanvasElement` in `html5-qrcode.js`), and `drawImage` scales the source crop into it. On a portrait phone the
   video is ~1.8× wider in source pixels than on screen, so the posters' dense
   codes lose most of the resolution the 1280×720 request bought.
6. **Focus is never requested.** Phones that pick a fixed-focus or slow-focus
   lens for `facingMode: environment` (common on multi-camera Androids, where
   it can be the ultra-wide) stay blurry on a dense code held close.

Items 1, 4 and 5 depend on how fast the CPU is, which explains why the same
build is "extremely fast" on some phones and slow on others. iOS Safari has no
`BarcodeDetector`, so it always uses ZXing JS.

The logger only writes to the console (`modules/log/logger.ts`) and nothing
reaches the server, so there is no field data on which phones are affected.

## Success criteria

Measured on the device matrix below, with the posters' codes printed at event
size, from viewfinder ready to `onScan`:

- Median time to decode on the low-end Android **≤ 1 s**, down from the
  baseline Phase 0 records.
- No regression on the mid-range Android, the iPhone, or in the WhatsApp
  in-app browser.
- Torch, camera switch, the warm hold (`keepWarmMs`) and the 1,500 ms repeat
  guard behave as they do today.

**Device matrix:** one low-end Android (≤ 3 GB RAM, the volunteers' class of
phone), one mid-range Android with several rear cameras, one iPhone on current
iOS, and the WhatsApp in-app browser on Android.

## Phase 0 — Baseline

_No code is merged in this phase._

On each device in the matrix, measure time to decode for the dense poster code
at arm's length and close up, ten attempts each. Use a local build with
`verbose: true` passed to the `Html5Qrcode` constructor. The shim then logs the
mean decode time every 100 runs, which can be read through `chrome://inspect`
or Safari Web Inspector. Record the track's `getSettings()` (resolution, and
`deviceId`/label) and `getCapabilities().focusMode`.

Ask the volunteers who complained which phone and browser they used, and
include one of those phones if possible.

**Output:** a table in this document, which is the baseline for the success
criteria.

## Phase 1 — Configuration stopgap (optional)

Branch: `perf/qr-scanner-config`. One file: `modules/qr/qr.ts`.

Phase 2 removes html5-qrcode, so this phase is throwaway. Ship it only if an
event is due before Phase 2 lands.

- Construct with `formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]` and
  `verbose: false`. The enum comes from the same dynamic import, so the chunk
  boundary does not move.
- Pass `disableFlip: true` to `start`.
- Leave `fps` at 10. Raising it while half the frames still go to ZXing JS adds
  main-thread load on exactly the phones that are slow.

**Verification:** the Phase 0 matrix shows no regression. `npm run lint`,
`npm run typecheck` and `npm test` pass.

## Phase 2 — Replace html5-qrcode

Items 1, 4 and 5 are inside html5-qrcode, so no option fixes them. We drop the
library and drive the camera and the decoder ourselves. The native
`BarcodeDetector` is used where the browser supports `qr_code`. Elsewhere,
including iOS Safari, we use the
[`barcode-detector`](https://www.npmjs.com/package/barcode-detector) ponyfill,
which runs ZXing-C++ compiled to WebAssembly. It is much faster and more
tolerant than the ZXing JS port html5-qrcode bundles.

`qr.ts` already owns everything around the camera: constraints, torch, facing,
the warm hold, the repeat guard, the help timeouts and the UI states. It uses
only six members of `Html5Qrcode`: `start`, `stop`, `pause(true)`, `resume`,
`applyVideoConstraints` and `getRunningTrackCapabilities`. The replacement
offers that same small surface, so `qr.ts` changes where it calls the scanner,
not how it behaves.

**Rejected alternative:** patching html5-qrcode with `patch-package`, so it
uses only the native decoder and decodes at source resolution. It is
smaller, but iOS would stay on ZXing JS, and we would be carrying a patch
against an unmaintained library that has already caused the worst scanner bug
so far (the aspect-ratio fault fixed before this repository's history begins).

Each step below is one branch, one review and one merge into `develop`. The
scanner keeps working after every merge.

### 2a — Crop geometry

Branch: `feat/qr-crop-geometry`.

- `modules/qr/crop.ts`: a pure function that turns the video's intrinsic size,
  its rendered box (`object-fit: cover`) and the viewfinder's on-screen
  square into the **source-pixel** rectangle to decode. It replaces html5-qrcode's
  per-axis mapping, the cause of the `1.0.0` bug. The rectangle is clamped to
  the frame.
- `decode-box.ts` is reused for the viewfinder margin. Its `MIN_DECODE_SIDE`
  exists only because html5-qrcode throws below it, so it is kept or dropped
  on its merits.
- `crop.test.ts` covers portrait and landscape streams, a box wider and a box
  taller than the stream, a front camera (mirroring is CSS only, so the
  rectangle is not mirrored), and a zero-size box before layout.

### 2b — Decoder

Branch: `feat/qr-decoder`.

- `modules/qr/decoder.ts` exports `createDecoder(): Promise<Decoder>`, where
  `Decoder` has `decode(source: CanvasImageSource) => Promise<string | null>`.
  It uses the native `BarcodeDetector` when `'BarcodeDetector' in window` and
  `getSupportedFormats()` includes `qr_code`. Otherwise it imports the ponyfill
  with a dynamic `import()`, so the WebAssembly is fetched only on the fallback
  path. Both are created with `formats: ['qr_code']`. When several codes are
  in view, the largest wins, as html5-qrcode did.
- **Self-hosting the `.wasm` file:** the ponyfill fetches its ZXing-C++
  `.wasm` (~1 MB) from a CDN by default. We point it at a file we serve
  instead, using the ponyfill's documented override for the file's location,
  and `scripts/build-client.ts` copies that file into the webroot under a
  hashed name. Pin the exact version of `barcode-detector` (no caret), so the
  JavaScript and the `.wasm` file always come from the same release.
- **CSP:** `scriptSrc` in `src/app.ts` gains `'wasm-unsafe-eval'`. That
  permits compiling WebAssembly only, not `eval`. `src/fallback/app.ts` does
  not serve the scanner and is left alone. Confirm the `.wasm` file is served
  as `application/wasm` and is cached like the JS chunks
  ([`asset-delivery.md` § JavaScript](../infrastructure/asset-delivery.md#javascript)).
- Unit-test the selection logic with `BarcodeDetector` stubbed on
  `globalThis`: native is chosen when it supports `qr_code`, the ponyfill is
  chosen when it does not or when the constructor is missing, and the largest
  code wins. Decoding itself is covered by the device matrix, not by Node.

### 2c — Camera scanner

Branch: `feat/qr-camera-scanner`.

- `modules/qr/camera-scanner.ts`, a class whose public surface is the six
  members listed above, so `qr.ts` can swap it in one change:
  - `start(facing, onDecode)` calls `getUserMedia` with today's constraints
    (`ideal` 1280×720), attaches the stream to a `<video playsinline muted>`
    that we create inside `qrReaderDiv`, and waits for the first frame.
  - The decode loop runs off `requestVideoFrameCallback` where available,
    and off `setTimeout` otherwise. **One decode is in flight at a time**,
    with no fixed fps: a fast decoder sees every frame, and a slow one is
    never queued behind itself. Each pass draws the crop from 2a into a
    reused canvas **at source resolution**, capped at the longer side of the
    stream, and hands it to the decoder from 2b.
  - `pause()` freezes the video and stops the loop, matching
    `pause(true)` today. `resume()` restarts both.
  - `stop()` stops every track and removes the video.
  - The track's `getCapabilities` and `applyVideoConstraints` are exposed
    directly, so `setupTorch` keeps its logic.
- No `fps`, `disableFlip` or format list to configure: this step removes
  items 2 to 5 by construction.

### 2d — Switch `qr.ts` over

Branch: `feat/qr-own-scanner`.

- `qr.ts` imports `camera-scanner.ts` dynamically, where it imports
  html5-qrcode today. The warm-up `import()` at line ~562 and the chunk split
  in `scripts/build-client.ts` move to the new module.
- `waitForVideoReady` is replaced by `start` resolving on the first frame.
  The skeleton, the permission-prompt hint and the close-during-download guard
  stay as they are.
- The camera switch stays a stop and start. Our track would accept
  `facingMode` through `applyVideoConstraints`, but browsers do not reliably
  switch devices that way.
- `qr.css`: remove the rules that exist only for html5-qrcode's DOM
  (`#qr-shaded-region`, its status line, the per-axis mapping notes). Keep the
  stream-aspect video sizing in `lvh` and the viewfinder, since 2a depends on
  them.
- Remove `html5-qrcode` from `package.json` and the lockfile.

### Phase 2 verification

- The Phase 0 matrix meets the success criteria. On the iPhone, the decoder
  in use is the ponyfill, confirmed in Web Inspector.
- On Android and iOS, check:
  - torch on and off, and the torch put out on close;
  - camera switch and switch-back after a refusal;
  - warm resume within `keepWarmMs`, and release after it;
  - closing during the chunk download, and during the `.wasm` download;
  - permission denied, and a prompt left unanswered;
  - the 1,500 ms repeat guard, and `onScan` throwing (the scanner resumes);
  - the `/staff` queue scanning several attendees in a row.
- The pages that do not scan download neither the scanner chunk nor the
  `.wasm` file. Compare the byte counts in
  `docs/infrastructure/asset-delivery.md`.
- `npm run lint`, `npm run typecheck`, `npm test` and the view snapshots pass.

## Phase 3 — Focus and lens

Branch: `perf/qr-scanner-focus`. Run it only if the Phase 2 matrix still shows
devices where blur is what slows the decode.

- After the track starts, apply `focusMode: 'continuous'` through
  `applyVideoConstraints` where `getCapabilities().focusMode` includes it, the
  same way the torch is handled now. Failures are logged at `warn`, not
  reported to the user.
- If Phase 0 shows a multi-camera Android choosing a lens without
  autofocus, prefer the rear device whose capabilities include
  `continuous`/`single-shot` focus. Don't match on labels, since they are not
  stable across vendors. Keep the camera-switch button's behaviour unchanged.

**Verification:** the dense code at 15 cm on the multi-camera Android decodes
without the user moving the phone back.

## Out of scope

- A native app or a PWA wrapper. The gap that remains after Phase 2 is focus
  control on iOS, and a wrapper is not justified for that.
- Decoding in a Web Worker. One decode in flight at a time already keeps the
  main thread responsive. Revisit only if the matrix shows UI jank on the
  ponyfill path.
- Server-side telemetry of decode times. It could replace Phase 0's manual
  measurement for the next event, but it is a separate decision about what the
  client reports.

## Documentation

Each step updates `CHANGELOG.md`. 2b updates
`docs/security/security-overview.md` (`'wasm-unsafe-eval'`, the self-hosted
`.wasm` file) and `docs/infrastructure/asset-delivery.md`. 2d updates the
asset-delivery byte counts and removes or rewrites every comment in `qr.ts`
and `qr.css` that describes html5-qrcode behaviour.
