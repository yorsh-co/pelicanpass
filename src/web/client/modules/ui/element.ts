/**
 * Toggles a class on the frame after next.
 *
 * The double `requestAnimationFrame` is what lets the CSS transition run: a
 * class toggled in the same frame the element was inserted is applied before
 * the browser has laid it out, and the transition is skipped.
 *
 * @param el - Element to toggle.
 * @param className - Class to add or remove.
 * @param on - Whether the class should be present.
 */
const setClassNextFrame = (
  el: Element,
  className: string,
  on: boolean,
): void => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.toggle(className, on);
    });
  });
};

/**
 * Shows or hides an element on the frame after next.
 *
 * @param el - Element to toggle.
 * @param show - Whether the element should be shown.
 */
const setShow = (el: Element, show: boolean): void => {
  setClassNextFrame(el, 'show', show);
};

/**
 * Marks an element as busy on the frame after next.
 *
 * @param el - Element to toggle.
 * @param isProcessing - Whether the element is mid-operation.
 */
const setProcessing = (el: Element, isProcessing: boolean): void => {
  setClassNextFrame(el, 'processing', isProcessing);
};

const element = { setShow, setProcessing };
export default element;
