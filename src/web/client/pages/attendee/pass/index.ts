import store from './state/store.ts';

import layoutDom from '../../../layouts/main/layout-dom.ts';
import { setupLogout } from '../../../layouts/main/logout.ts';
import utils from '../../../modules/utils/index.ts';
import toast from '../../../modules/ui/toast.ts';
import { bootScreen } from '../../../modules/ui/bootScreen.ts';
import { logger } from '../../../modules/log/logger.ts';

import type { PassState } from './state/store.ts';
import { BOOT_MIN_MS } from '../../../modules/ui/pacing.ts';
import ui from '../../../modules/ui/index.ts';
import dom from './dom.ts';
import { PASS_COPY } from './ui/messages.ts';
import { passInitErrorMessage } from './ui/init-error.ts';
import { renderLive, renderPass } from './ui/pass.ts';
import { setupNicknameEditor } from './ui/nickname.ts';
import { setupSurvey, showDeferredSurveyToast } from './ui/survey.ts';
import { setupFaces } from './ui/face.ts';
import { setupMap } from './ui/map.ts';
import { startLive } from './ui/live.ts';
import { startFrontPoll } from './ui/front-poll.ts';
import { startFrontClock } from './ui/front-clock.ts';

import { setupBandRetry } from '../../../modules/ui/band-loop.ts';

import type { AttendeePass } from '../../../core/api/api.attendee.ts';

const bootStartTime = Date.now();

/** The payload `web.routes` renders into the page's `#attendee-data` tag. */
interface PassInitialData {
  data?: {
    session?: PassState['session'];
    profile?: PassState['profile'];

    /**
     * The rotating half, seeded by the render so the pass is complete at first
     * paint rather than a blank QR box until the first poll answers.
     */
    pass?: AttendeePass;
  };
}

const init = async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('error');

    window.history.replaceState(null, '', '/pass');

    document.body.dataset.page = 'pass';

    // show flash error if redirected from a failed init
    if (errorCode) {
      void toast.warn(passInitErrorMessage(PASS_COPY.init, errorCode));
    }

    // extract initial data
    const el = document.getElementById('attendee-data');
    if (!el) throw new Error('Missing attendee-data');

    const initialData = JSON.parse(el.textContent) as PassInitialData | null;

    const data = initialData?.data ?? {};

    const profile = data.profile ?? {};

    store.setState({
      session: data.session ?? {},
      profile,
    });

    renderPass(profile);

    // The seed is what the page was rendered with, so it is already correct for
    // this window; `startLive` only has to keep it that way — and it does not
    // start doing so until the pass is turned over to the face the QR is on.
    let live;

    if (data.pass) {
      renderLive(data.pass);
      live = startLive(data.pass);
    }

    setupFaces(startFrontPoll(), live);
    setupMap();
    setupBandRetry(dom.retry, live);
    setupNicknameEditor();
    setupSurvey();

    // Outside the `if (data.pass)` above, deliberately. This depends on nothing
    // the server sent, and the render that seeded no pass — the one whose band
    // and code are missing — is the last one that should also be missing its
    // only sign of life.
    startFrontClock();

    ui.skeleton.clear(dom.pass);

    // close boot-screen
    await utils.timing.waitForNextPaint();

    await utils.timing.waitForNextInterval(bootStartTime, BOOT_MIN_MS);

    const boot = bootScreen(layoutDom.bootScreen);
    boot.hide();

    // Anything that animates to be noticed keys on this, not on first paint,
    // which the boot screen covers.
    dom.pass.dataset.revealed = '';

    showDeferredSurveyToast();
  } catch (err) {
    logger.error('init', 'pass init failed', { err });

    const isUnrecoverable =
      err instanceof SyntaxError ||
      (err instanceof Error && err.message === 'Missing attendee-data');

    if (isUnrecoverable) {
      window.location.href = '/pass'; // server will re-render a clean state
      return;
    }

    // recoverable: UI layer failure, session is intact
    void toast.error(PASS_COPY.init.recoverableError);
  }
};

// This bundle is loaded as a module script, which is deferred: the document is
// already parsed by the time it runs.
setupLogout();
void init();
