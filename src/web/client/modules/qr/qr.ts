import { logger } from '../log/logger.ts';
import ui from '../ui/index.ts';
import utils from '../utils/index.ts';
import { ApiError } from '../../core/api/api.error.ts';
import { MIN_PROCESSING_MS, SUCCESS_DWELL_MS } from '../ui/pacing.ts';
import { decodeBoxSide } from './decode-box.ts';

import type { Html5Qrcode } from 'html5-qrcode';
import type { FlowOptions, QrCopy } from './qr.types.ts';

/** Everything `setupQr` needs to drive the scanner and report on it. */
export interface QrSetupParams {
  qrReaderDiv: HTMLElement;
  startCameraBtn: HTMLButtonElement;
  hintDiv: HTMLElement;
  torchBtn: HTMLButtonElement;
  switchBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;

  /** Handles a decoded code. Throwing resumes the scanner. */
  onScan: (qrText: string) => Promise<void> | void;

  onProcessingStart?: (msg: string) => Promise<void> | void;
  onProcessingEnd?: (
    msg: string | null,
    options?: FlowOptions,
  ) => Promise<void> | void;
  onError?: (msg: string) => Promise<void> | void;

  /**
   * How long to keep the camera acquired after a successful scan, so the next
   * one costs no `getUserMedia`.
   *
   * Omit it and the scanner is stopped the moment a scan lands.
   *
   * Only worth passing on a surface that scans repeatedly: holding the track
   * keeps the operating system's camera indicator lit.
   */
  keepWarmMs?: number;

  copy: QrCopy;
}

/**
 * Camera capabilities the standard `MediaTrackCapabilities` does not declare.
 *
 * `torch` is real and widely implemented on Android, but it is absent from the
 * TypeScript DOM library, so it is described here rather than asserted away at
 * each use.
 */
interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

/** Which way the camera points. `environment` is where every scan starts. */
type Facing = 'environment' | 'user';

/**
 * Wires the "start camera" button to an html5-qrcode scanner.
 *
 * The scanner is paused while a scan is in flight and resumed if the scan
 * fails, so a rejected code can be retried without restarting the camera.
 *
 * While the camera runs, `body[data-camera="on"]` puts the page into the
 * full-screen scanning state. This is the step most likely to fail — camera
 * permission, a dim room, glare on a printed poster — and it used to be the
 * smallest element on the page.
 *
 * @param params - Elements, callbacks and copy for the qr step.
 */
export const setupQr = ({
  qrReaderDiv,
  startCameraBtn,
  hintDiv,
  torchBtn,
  switchBtn,
  closeBtn,
  onScan,

  onProcessingStart,
  onProcessingEnd,
  onError,

  keepWarmMs,

  copy,
}: QrSetupParams): void => {
  let scanner: Html5Qrcode | undefined;

  /** Releases the held camera once nobody has come back for it. */
  let warmTimer: number | undefined;

  /** Whether the running track has a torch, and whether it is lit. */
  let torchAvailable = false;
  let torchOn = false;

  /**
   * Which camera the feed is on, and whether there is another to reach.
   *
   * Both sit beside `scanner` rather than inside the click handler because a
   * held camera outlives it: the volunteer surface reopens the viewfinder on
   * the same track, and it should come back pointing where it was left.
   */
  let facing: Facing = 'environment';
  let switchAvailable = false;

  /** Puts the torch out, for a track that is about to outlive the viewfinder. */
  const extinguishTorch = async (held: Html5Qrcode) => {
    if (!torchOn) return;

    try {
      await held.applyVideoConstraints({
        advanced: [{ torch: false } as MediaTrackConstraintSet],
      });
    } catch (err) {
      logger.warn('qr', 'torch could not be put out', { err });
    }

    torchOn = false;
  };

  /** Stops and forgets the scanner, whether it was running or held. */
  const releaseScanner = () => {
    window.clearTimeout(warmTimer);

    const held = scanner;
    scanner = undefined;
    torchAvailable = false;
    torchOn = false;

    // The handler closes over the instance being dropped, so it must go with
    // it; a cold start wires a new one. Every cold start also opens on the
    // rear camera, whatever the last session chose.
    switchBtn.onclick = null;
    switchAvailable = false;
    facing = 'environment';

    if (!held) return;

    void held.stop().catch((err: unknown) => {
      logger.debug('qr', 'scanner stop failed', { err });
    });
  };

  // Only when the camera is held between scans. `setupQr` runs on every entry
  // to the check-in page's qr step, so an unconditional listener would stack one
  // per entry there; the staff page calls it once.
  //
  // Released on hide rather than left to the timer because a backgrounded stream
  // can come back unusable on iOS — rebuilding beats resuming into that.
  if (keepWarmMs !== undefined) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseScanner();
    });
  }

  startCameraBtn.onclick = () => {
    void (async () => {
      const qrWrapper = qrReaderDiv.closest('.qr-reader-wrapper');

      let helpTimeout: number | undefined;
      let permissionTimeout: number | undefined;

      /**
       * Whether the camera still owns the screen.
       *
       * The dataset flag is the same signal the stylesheet reads, so there is
       * no second piece of state to keep in step: once `leaveCameraMode` has
       * run, every await still in flight below knows to unwind.
       */
      const isCameraMode = () => document.body.dataset.camera === 'on';

      /**
       * Releases a scanner whose `start` resolved after the page had already
       * left camera mode. `closeCamera` may have stopped it first, so a
       * rejection here is the expected case rather than a notable one.
       */
      const releaseLateScanner = (late: Html5Qrcode) => {
        if (scanner === late) scanner = undefined;

        // `startScanner` stamps the facing after the camera answers, which can
        // be after `leaveCameraMode` has already cleared it.
        delete document.body.dataset.facing;

        void late.stop().catch((err: unknown) => {
          logger.debug('qr', 'late scanner stop failed', { err });
        });
      };

      /** Returns the page to its non-camera state. */
      const leaveCameraMode = () => {
        delete document.body.dataset.camera;
        delete document.body.dataset.facing;
        closeBtn.onclick = null;
        torchBtn.hidden = true;
        torchBtn.setAttribute('aria-pressed', 'false');
        torchBtn.classList.remove('is-on');

        // Hidden but still wired: a camera kept warm is reopened on the same
        // instance the handler closes over. `releaseScanner` unwires it.
        switchBtn.hidden = true;
        switchBtn.disabled = false;
      };

      /**
       * Returns the step to its inline, pre-camera shape.
       *
       * Every way out of camera mode owes the step this, including a
       * successful scan: a page that stays put afterwards — the volunteer
       * scanning surface does — is otherwise left with a collapsed-but-shown
       * wrapper and a start button that is hidden and disabled, which is a page
       * that scans once and then needs a reload.
       */
      const restoreStepShape = () => {
        if (qrWrapper) ui.element.setShow(qrWrapper, false);

        ui.element.setShow(startCameraBtn, true);
        startCameraBtn.disabled = false;
      };

      /** Stops the scanner and returns the step to its inline, pre-camera state. */
      const closeCamera = () => {
        clearTimeout(helpTimeout);
        clearTimeout(permissionTimeout);

        // Before the scanner is released, not after: releasing a camera takes
        // a visible beat, and the overlay should go on tap.
        leaveCameraMode();
        restoreStepShape();

        void onProcessingEnd?.(copy.defaultHint);

        // An explicit close means done, so a held camera is let go rather than
        // kept warm for a scan that is not coming.
        releaseScanner();
      };

      /**
       * Reopens a camera that was never released.
       *
       * Everything the cold path waits for — the chunk, the constructor,
       * `getUserMedia`, the first video frame — has already happened, so there
       * is nothing to show a skeleton for.
       */
      const resumeWarm = (held: Html5Qrcode) => {
        window.clearTimeout(warmTimer);

        document.body.dataset.camera = 'on';
        document.body.dataset.facing = facing;
        closeBtn.onclick = closeCamera;

        startCameraBtn.disabled = true;
        ui.element.setShow(startCameraBtn, false);

        if (qrWrapper) ui.element.setShow(qrWrapper, true);
        if (torchAvailable) torchBtn.hidden = false;
        if (switchAvailable) switchBtn.hidden = false;

        held.resume();

        void ui.hint.showHint(hintDiv, copy.defaultHint);
      };

      if (keepWarmMs !== undefined && scanner) {
        resumeWarm(scanner);
        return;
      }

      // Nothing here is resumable, so anything still held is stale — a start
      // that threw half-built leaves an instance behind. Clearing it is what
      // keeps the guarantee this used to get for free from a `let` inside the
      // handler: every cold start begins from nothing.
      releaseScanner();

      try {
        // Set first so that `isCameraMode` is meaningful from here on, and so
        // that the tap produces the full-screen shape immediately.
        document.body.dataset.camera = 'on';

        // Wired before the scanner exists on purpose: the states most worth
        // escaping — an unanswered permission prompt, a feed that never starts
        // — all happen before `scanner.start` resolves.
        closeBtn.onclick = closeCamera;

        permissionTimeout = setTimeout(() => {
          void ui.hint.showHint(hintDiv, copy.cameraAccessRequest);
        }, 3000);

        startCameraBtn.disabled = true;
        ui.element.setShow(startCameraBtn, false);

        if (qrWrapper) {
          ui.skeleton.render(qrWrapper);
          ui.element.setShow(qrWrapper, true);
        }

        // ~5,500 lines of ZXing, fetched only once someone asks for the camera.
        // Nobody on the ticket step needs it, and this runs on the most
        // congested network the app will ever see.
        const { Html5Qrcode } = await import('html5-qrcode');

        // Closed while the chunk was still downloading: never touch the camera.
        if (!isCameraMode()) return;

        const active: Html5Qrcode = new Html5Qrcode(qrReaderDiv.id);
        scanner = active;

        // The help text is on screen for the whole step now, so this only
        // records that scanning is taking a long time.
        const startHelpTimeout = (delay = 20000) => {
          clearTimeout(helpTimeout);

          helpTimeout = setTimeout(() => {
            logger.warn('qr', 'qr scan timeout');
          }, delay);
        };
        startHelpTimeout();

        let isProcessing = false;
        let lastScanTime = 0;

        const handleScan = async (decodedText: string) => {
          // guard against repeated scans
          const scanStartTime = Date.now();
          if (scanStartTime - lastScanTime < 1500) return;
          if (isProcessing) return;

          lastScanTime = scanStartTime;
          isProcessing = true;
          logger.debug('qr', `qr code scanned ${decodedText}`);

          try {
            active.pause(true);

            clearTimeout(helpTimeout);

            await onProcessingStart?.(copy.processing);

            await onScan(decodedText);

            if (keepWarmMs === undefined) {
              void active.stop();
              scanner = undefined;
            } else {
              // Already paused above, so the track simply stays acquired. The
              // torch does not: a lit phone going into a pocket is the one
              // thing this path could get badly wrong.
              await extinguishTorch(active);

              warmTimer = window.setTimeout(releaseScanner, keepWarmMs);
            }

            leaveCameraMode();
            restoreStepShape();
          } catch (err) {
            const code = err instanceof ApiError ? err.code : undefined;
            const msg =
              (code ? copy.error[code] : undefined) ?? copy.unknownError;

            await utils.timing.ensureMinimum(scanStartTime, MIN_PROCESSING_MS);

            void onError?.(msg);

            await utils.timing.ensureMinimum(
              scanStartTime,
              MIN_PROCESSING_MS + SUCCESS_DWELL_MS,
            );

            void onProcessingEnd?.(null, { keepHint: true });

            active.resume();

            startHelpTimeout(10000);
          } finally {
            isProcessing = false;
          }
        };

        /** Points the scanner at one camera and records where it is aimed. */
        const startScanner = async (next: Facing) => {
          await active.start(
            { facingMode: next },
            {
              fps: 10,
              // The posters' codes are dense, and the default stream gives each
              // module too few pixels to decode. `ideal` lets a camera that
              // cannot do 720p fall back instead of failing. The library uses
              // this in place of the first argument, which it still requires.
              videoConstraints: {
                facingMode: next,
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              // Sized from the drawn viewfinder so a code filling the brackets
              // is the code that gets decoded.
              qrbox: (boxWidth, boxHeight) => {
                const side = decodeBoxSide(
                  qrWrapper
                    ?.querySelector('.qr-viewfinder')
                    ?.getBoundingClientRect().width ?? 0,
                  boxWidth,
                  boxHeight,
                );

                return { width: side, height: side };
              },
            },
            (decodedText) => void handleScan(decodedText),
            undefined, // per-frame decode-failure callback
          );

          facing = next;

          // The stylesheet mirrors the front feed off this. Decoding reads raw
          // frames, so the transform is cosmetic — but aiming at a code held up
          // to a selfie camera is unreadable without it.
          document.body.dataset.facing = next;
        };

        /** Guards the flip against a second tap while one is in flight. */
        let switching = false;

        /**
         * Flips the feed to the other camera, and back on the next tap.
         *
         * html5-qrcode refuses `facingMode` through `applyVideoConstraints`, so
         * this is a real stop and start on the same instance: the video element
         * goes away and comes back, which is what the skeleton covers.
         *
         * A refusal from the far camera is put back the way it was rather than
         * reported — the near one was working a moment ago, and a rear camera
         * that cannot be left is not a failure worth a message.
         */
        const switchCamera = async () => {
          if (isProcessing || switching) return;

          switching = true;
          switchBtn.disabled = true;

          const previous = facing;

          try {
            // Capabilities belong to the track, and a front camera almost never
            // has a torch: a button carried over from the old one would point
            // at a light that no longer exists.
            await extinguishTorch(active);
            torchAvailable = false;
            torchBtn.hidden = true;

            if (qrWrapper) ui.skeleton.render(qrWrapper);

            await active.stop();

            try {
              await startScanner(
                previous === 'environment' ? 'user' : 'environment',
              );
            } catch (err) {
              logger.warn('qr', 'camera switch refused, reverting', { err });
              await startScanner(previous);
            }

            if (!isCameraMode()) return;

            await waitForVideoReady(qrReaderDiv);

            if (!isCameraMode()) return;

            if (qrWrapper) ui.skeleton.clear(qrWrapper);

            torchAvailable = setupTorch(active, torchBtn, (on) => {
              torchOn = on;
            });
          } catch (err) {
            // The revert threw too, or the feed never came back: there is no
            // camera left to hand over, so the step goes back to its inline
            // shape rather than sitting on a dead viewfinder.
            if (!isCameraMode()) return;

            logger.error('qr', 'camera switch left no working camera', { err });

            void onError?.(copy.cameraAccessError);
            closeCamera();
          } finally {
            switching = false;
            switchBtn.disabled = false;
          }
        };

        await startScanner('environment');

        clearTimeout(permissionTimeout);

        // `start` can resolve long after the close button was pressed — an
        // unanswered permission prompt has no time limit. Without this the
        // camera would reopen over a page the attendee has already left.
        if (!isCameraMode()) {
          releaseLateScanner(active);
          return;
        }

        void ui.hint.showHint(hintDiv, copy.defaultHint);

        await waitForVideoReady(qrReaderDiv);

        if (!isCameraMode()) {
          releaseLateScanner(active);
          return;
        }

        if (qrWrapper) ui.skeleton.clear(qrWrapper);

        torchAvailable = setupTorch(active, torchBtn, (on) => {
          torchOn = on;
        });

        switchAvailable = await hasCameraToSwitchTo();

        if (!isCameraMode()) {
          releaseLateScanner(active);
          return;
        }

        if (switchAvailable) {
          switchBtn.hidden = false;
          switchBtn.onclick = () => void switchCamera();
        }

        logger.info('qr', 'qr scanner started');
      } catch (err) {
        // A close mid-startup makes the camera reject; `closeCamera` has
        // already restored the step, and this was not a failure to report.
        if (!isCameraMode()) return;

        logger.error('qr', 'qr scanner failed to start', { err });

        clearTimeout(helpTimeout);
        clearTimeout(permissionTimeout);

        // A half-built scanner is not resumable and must not be left for the
        // next tap to find.
        releaseScanner();

        void onError?.(copy.cameraAccessError); // FIXME: handle different error types

        leaveCameraMode();
        restoreStepShape();
      }
    })();
  };
};

/**
 * Warms the module cache for the scanner chunk.
 *
 * `setupQr` imports `html5-qrcode` on the first tap.
 *
 * Deliberately not awaited and deliberately silent: it is an optimisation, and
 * the tap that needs it will import it again and get the same promise.
 */
export const prefetchScanner = (): void => {
  void import('html5-qrcode').catch((err: unknown) => {
    logger.debug('qr', 'scanner prefetch failed', { err });
  });
};

/**
 * Whether this device has a camera worth switching to.
 *
 * Deliberately generous, unlike the torch's capability check: the control
 * exists for a main camera that does not work, so only a firm count of one is
 * treated as "no". A probe that is blocked, unsupported, or returns nothing
 * leaves the escape hatch in place — a switch that fails says so, whereas a
 * button that was never shown cannot be found at all.
 *
 * Call it only once the feed is up: before permission is granted the device
 * list is incomplete.
 *
 * @returns Whether to offer the switch.
 */
const hasCameraToSwitchTo = async (): Promise<boolean> => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    return (
      devices.filter((device) => device.kind === 'videoinput').length !== 1
    );
  } catch (err) {
    logger.debug('qr', 'camera enumeration failed', { err });
    return true;
  }
};

/**
 * Reveals and wires the torch toggle, if this camera has one.
 *
 * Scanning a printed poster in a dim auditorium is exactly when a flashlight is
 * wanted, and it can be the difference between a code that reads and one that
 * does not. Support is uneven — generally yes on Android, no on iOS Safari — so
 * the button stays hidden unless the running track reports the capability,
 * rather than offering a control that silently does nothing.
 *
 * @param scanner - The running scanner.
 * @param torchBtn - Button to reveal and wire.
 * @param onToggle - Told whenever the light actually changes state, so a caller
 *   holding the track after the viewfinder closes knows to put it out.
 * @returns Whether this camera has a torch at all, which is also whether the
 *   button was revealed.
 */
const setupTorch = (
  scanner: Html5Qrcode,
  torchBtn: HTMLButtonElement,
  onToggle: (on: boolean) => void,
): boolean => {
  let capabilities: TorchCapabilities;

  try {
    capabilities = scanner.getRunningTrackCapabilities();
  } catch (err) {
    logger.debug('qr', 'track capabilities unavailable', { err });
    return false;
  }

  if (!capabilities.torch) {
    logger.debug('qr', 'camera reports no torch');
    return false;
  }

  let on = false;
  torchBtn.hidden = false;

  torchBtn.onclick = () => {
    void (async () => {
      const next = !on;

      try {
        await scanner.applyVideoConstraints({
          advanced: [{ torch: next } as MediaTrackConstraintSet],
        });

        on = next;
        onToggle(on);
        torchBtn.setAttribute('aria-pressed', String(on));
        torchBtn.classList.toggle('is-on', on);
      } catch (err) {
        logger.warn('qr', 'torch toggle failed', { err });
        torchBtn.hidden = true;
      }
    })();
  };

  return true;
};

/**
 * Resolves once the scanner's video element is actually playing.
 *
 * The timeout only starts once a video element appears: html5-qrcode inserts
 * it after the camera permission prompt is answered, and that prompt has no
 * time limit.
 *
 * @param qrEl - Element the scanner renders into.
 * @param timeoutMs - How long the video may take to load once it exists.
 * @throws {Error} If the video appears but never loads.
 */
const waitForVideoReady = (
  qrEl: HTMLElement,
  timeoutMs = 5000,
): Promise<HTMLVideoElement> =>
  new Promise((resolve, reject) => {
    let videoDetectedAt: number | null = null;

    const check = () => {
      const video = qrEl.querySelector('video');

      if (video) {
        videoDetectedAt ??= Date.now();

        if (video.readyState >= 2) {
          resolve(video);
          return;
        }

        if (Date.now() - videoDetectedAt > timeoutMs) {
          reject(new Error('Video element present but not loading'));
          return;
        }
      }

      requestAnimationFrame(check);
    };

    check();
  });
