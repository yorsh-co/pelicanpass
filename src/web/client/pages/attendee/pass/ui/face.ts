import dom from '../dom.ts';

import type { LiveController } from './live.ts';
import type { FrontPoll } from './front-poll.ts';

/** Which face of the pass is up. */
type Face = 'front' | 'back' | 'actions';

/**
 * The face now showing. Module state, like the polls it drives: there is one
 * pass per page, and the tab needs it to tell opening the actions from closing
 * them.
 */
let current: Face = 'front';

/**
 * Switches the pass to another face.
 *
 * `hidden` rather than a class: the reset gives it `display: none !important`
 * (`base/reset.css:42`), which takes the face out of the layout, the tab order
 * and the accessibility tree in one attribute.
 *
 * The scroll reset matters more than it looks. The front is taller than a phone
 * screen and the back is not, so turning the pass over from halfway down the
 * chips would otherwise land on an empty column below the QR.
 *
 * @param face - The face to show.
 * @param front - The front's status poll.
 * @param live - The poll controller, absent when the render seeded no pass.
 */
const setFace = (face: Face, front: FrontPoll, live?: LiveController): void => {
  const previous = current;
  current = face;

  dom.face.front.hidden = face !== 'front';
  dom.face.back.hidden = face !== 'back';
  dom.face.actions.hidden = face !== 'actions';

  dom.pass.dataset.face = face;

  // The wordmark is the front's tab only while it is the inactive one.
  dom.face.frontTab.hidden = face !== 'actions';
  dom.face.accessTab.setAttribute('aria-expanded', String(face === 'actions'));

  window.scrollTo({ top: 0 });

  // Focus follows the face, or a keyboard lands nowhere and a screen reader
  // stays on an element that is no longer in the tree. Leaving the actions
  // lands on the tab that opened them; leaving the back, on the button that did.
  if (face === 'actions') dom.face.hideActions.focus();
  else if (face === 'back') dom.face.hide.focus();
  else if (previous === 'actions') dom.face.accessTab.focus();
  else dom.face.show.focus();

  // One poll runs at a time. The back's last fetch on the way down already
  // refreshes what the front shows, so the front waits a full interval. The
  // front poll also carries the access tier, which the actions face is painted
  // from, so it keeps running there and is not restarted between the two.
  if (face === 'back') {
    front.suspend();
    live?.resume();
  } else if (previous === 'back') {
    live?.suspend();
    front.resume();
  }
};

/**
 * Wires the ways the pass switches face.
 *
 * The chips are listened to through their list rather than individually:
 * `renderChips` replaces them wholesale on every poll, and handlers bound to
 * the chips themselves would be discarded with the chips that carried them.
 *
 * @param front - The front's status poll from `startFrontPoll`.
 * @param live - The poll controller from `startLive`. Optional: when the render
 *   seeded no pass there is nothing to poll, and the pass must still turn over
 *   rather than dead-tap.
 */
export const setupFaces = (front: FrontPoll, live?: LiveController): void => {
  dom.face.chips.addEventListener('click', (event) => {
    const target = event.target;

    if (target instanceof Element && target.closest('.pass-chip')) {
      setFace('back', front, live);
    }
  });

  dom.face.show.onclick = () => {
    setFace('back', front, live);
  };

  dom.face.hide.onclick = () => {
    setFace('front', front, live);
  };

  // From any face, so the tab is always one tap from the actions; on the
  // actions it is the active tab and a second tap closes them.
  dom.face.accessTab.onclick = () => {
    setFace(current === 'actions' ? 'front' : 'actions', front, live);
  };

  dom.face.frontTab.onclick = () => {
    setFace('front', front, live);
  };

  dom.face.hideActions.onclick = () => {
    setFace('front', front, live);
  };
};
