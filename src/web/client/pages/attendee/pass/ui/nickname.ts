import dom from '../dom.ts';
import store from '../state/store.ts';
import { PASS_COPY } from './messages.ts';
import { renderDisplayName } from './pass.ts';

import api from '../../../../core/api/index.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import ui from '../../../../modules/ui/index.ts';
import toast from '../../../../modules/ui/toast.ts';
import { logger } from '../../../../modules/log/logger.ts';

import {
  isValidNickname,
  normaliseNickname,
} from '../../../../../../constants/nickname.ts';

/**
 * Shows the editor in place of the name line.
 *
 * The line under the name goes with it — the welcome, or a volunteer's team:
 * left on its own under an input it reads as a caption for the field. The hint takes its place while the editor is open.
 *
 * Seeded from the stored nickname rather than from the rendered name, which
 * falls back to the first name — offering that back as the value to edit would
 * turn a clear into a nickname that merely looks like the default.
 */
const open = (): void => {
  const { nickname, tagline } = dom;
  const { profile } = store.getState();

  nickname.input.value = profile?.attendeeNickname ?? '';

  nickname.line.hidden = true;
  tagline.hidden = true;
  nickname.form.hidden = false;

  void ui.hint.showHint(nickname.hint, PASS_COPY.nickname.hint);

  nickname.input.focus();
  nickname.input.select();
};

/**
 * Restores the name line and the line under it, and discards anything typed into the
 * editor.
 */
const close = (): void => {
  const { nickname, tagline } = dom;

  nickname.form.hidden = true;
  nickname.line.hidden = false;
  tagline.hidden = false;

  void ui.hint.clear(nickname.hint);
};

/**
 * Sends the typed value and re-renders the name from what came back.
 *
 * The client validates first for immediate feedback only. It runs the same
 * normalisation the server does, so the two agree on what an empty value is —
 * but the server is the boundary, and the name is rendered from its response
 * rather than from the input.
 */
const save = async (): Promise<void> => {
  const { nickname } = dom;

  const value = normaliseNickname(nickname.input.value);

  if (value !== '' && !isValidNickname(value)) {
    nickname.input.classList.add('error');

    await ui.hint.showError(nickname.hint, PASS_COPY.nickname.invalid);

    return;
  }

  nickname.input.classList.remove('error');
  nickname.save.disabled = true;
  ui.element.setProcessing(nickname.form, true);

  try {
    const stored = await api.attendee.setNickname(value);

    const { profile } = store.getState();

    store.setState({ profile: { ...profile, attendeeNickname: stored } });

    renderDisplayName(store.getState().profile ?? {});

    close();

    // NOTE: for now, do not toast this.
    /*void toast.info(
      stored === null ? PASS_COPY.nickname.cleared : PASS_COPY.nickname.saved,
    );*/
  } catch (err) {
    logger.warn('nickname', 'nickname update failed', { err });

    // A rejection the server made and the browser did not is still worth
    // showing in the field rather than as a toast: the value is on screen and
    // the attendee can edit it.
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      await ui.hint.showError(nickname.hint, PASS_COPY.nickname.invalid);
    } else {
      void toast.error(PASS_COPY.nickname.failed);
    }
  } finally {
    nickname.save.disabled = false;
    ui.element.setProcessing(nickname.form, false);
  }
};

/**
 * Wires the pass's name editor.
 *
 * Submit rather than click, so the keyboard's done key works. The form carries
 * a `pattern`, so the browser blocks an obviously wrong value before this runs;
 * {@link save} still validates, because the pattern cannot express the
 * combining-mark rule.
 */
export const setupNicknameEditor = (): void => {
  const { nickname } = dom;

  nickname.trigger.addEventListener('click', open);
  nickname.cancel.addEventListener('click', close);

  nickname.form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });
};
