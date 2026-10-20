import dom from '../dom.ts';
import { setupMapZoom } from './map-zoom.ts';

/**
 * Wires the venue map's dialog.
 *
 * `showModal()` rather than `show()`: the modal form is what makes the page
 * behind it inert, closes on Escape and hands focus back to whichever button
 * opened it, none of which needs code here.
 *
 * A tap on the backdrop reports the dialog as its target, but so does a tap on
 * the dialog's own padding, so the click is tested against the dialog's box.
 * On a phone the dialog fills the screen and there is no backdrop to tap.
 *
 * The zoom is reset as the map opens rather than as it closes: `close` fires
 * when the fade-out starts, and a reset then would snap the map back to its
 * fitted size in full view.
 */
export const setupMap = (): void => {
  const { chip, icon, hide, dialog, body, image } = dom.map;

  const zoom = setupMapZoom(body, image);

  const open = (): void => {
    zoom.reset();
    dialog.showModal();
  };

  chip.onclick = open;
  icon.onclick = open;

  hide.onclick = () => {
    dialog.close();
  };

  dialog.onclick = (event) => {
    if (event.target !== dialog) return;

    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;

    if (!inside) dialog.close();
  };
};
