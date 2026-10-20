import store from './state/store.ts';
import { ensureAudience } from './state/audience.ts';
import { goToStep } from './ui/navigation.ts';

import api from '../../../core/api/index.ts';
import layoutDom from '../../../layouts/main/layout-dom.ts';
import utils from '../../../modules/utils/index.ts';
import toast from '../../../modules/ui/toast.ts';
import { bootScreen } from '../../../modules/ui/bootScreen.ts';
import { trackVisualViewport } from '../../../modules/ui/visual-viewport.ts';
import { getAudienceCopy } from './ui/messages.ts';
import { initErrorMessage } from './ui/init-error.ts';
import { logger } from '../../../modules/log/logger.ts';

import type { CheckinApiResponse } from '../../../core/api/api.types.ts';
import { BOOT_MIN_MS } from '../../../modules/ui/pacing.ts';

const bootStartTime = Date.now();

const init = async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('error');
    const audienceHint = params.get('audience');

    window.history.replaceState(null, '', '/checkin');

    document.body.dataset.page = 'checkin';
    const audience = ensureAudience(audienceHint);

    if (errorCode) {
      const copy = getAudienceCopy({ audience }).init;
      void toast.warn(initErrorMessage(copy, errorCode));
    }

    const el = document.getElementById('checkin-data');
    if (!el) throw new Error('Missing checkin-data');

    const initialData = JSON.parse(el.textContent) as CheckinApiResponse | null;

    const initialStep = initialData?.meta?.nextStep ?? 'ticket';
    const captchaRequired = initialData?.meta?.captchaRequired;
    const data = initialData?.data ?? {};

    store.setState({
      captchaRequired: captchaRequired ?? null,
      currentUiStepKey: null,
      session: data.session ?? {},
      audienceHint: audience,
    });

    if (store.getState().currentUiStepKey !== initialStep) {
      await goToStep(initialStep, { skeleton: false });
    }

    await utils.timing.waitForNextPaint();

    await utils.timing.waitForNextInterval(bootStartTime, BOOT_MIN_MS);

    const boot = bootScreen(layoutDom.bootScreen);
    boot.hide();
  } catch (err) {
    logger.error('init', 'checkin init failed', { err });

    const isUnrecoverable =
      err instanceof SyntaxError ||
      (err instanceof Error && err.message === 'Missing checkin-data');

    if (isUnrecoverable) {
      window.location.href = '/checkin'; // server will re-render a clean state
      return;
    }

    // recoverable: UI layer failure, session is intact
    void toast.error(getAudienceCopy().init.recoverableError);
  }
};

const setupLogout = () => {
  layoutDom.logoutBtn.onclick = (e) => {
    void (async () => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;

      // Navigate either way: an expired session answers 401, and the reload
      // starts a fresh check-in.
      try {
        await api.checkin.reset();
      } catch (err) {
        logger.warn(
          'logout',
          err instanceof Error ? err.message : 'Check-in reset failed',
        );
      }

      // Encoded because the value lands in a query string; ensureAudience
      // already narrows it to a known audience.
      window.location.href = `/checkin?audience=${encodeURIComponent(ensureAudience())}`;
    })();
  };
};

// This bundle is loaded as a module script, which is deferred: the document is
// already parsed by the time it runs.
trackVisualViewport();
setupLogout();
void init();
