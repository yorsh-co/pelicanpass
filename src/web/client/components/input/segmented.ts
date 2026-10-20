/**
 * Renders a code input as one cell per character.
 *
 * The real `<input>` stays and keeps doing the work — paste,
 * `autocomplete="one-time-code"`, the debounce-then-submit in `ui/inputs.ts`,
 * validation against its `pattern`. It is simply made invisible and stretched
 * over the cells, which are a read-only mirror of its value. Nothing about the
 * submit path changes.
 *
 * This replaces the animated typewriter placeholder, which made an empty field
 * look filled, was invisible to assistive tech, and removed the instruction at
 * the moment of focus. The cell count now says how long the code is without any
 * instruction at all.
 *
 * The cells are `aria-hidden`: they duplicate the input's own value, and the
 * input carries the accessible name via its `<label>`.
 */

/** Marks the input so a second call re-renders rather than stacking listeners. */
const ATTACHED = 'segmented';

/**
 * Wires a segmented display onto a code input.
 *
 * Safe to call on every step entry — listeners are attached once, and later
 * calls only repaint, which is what a re-entered step needs after
 * `setupInput` has cleared the value.
 *
 * @param input - The input to mirror.
 * @param getLength - How many cells the current value calls for. Takes the
 *   value so a field whose length depends on what was typed can resize.
 */
export const attachSegmentedInput = (
  input: HTMLInputElement,
  getLength: (value: string) => number,
): void => {
  const wrapper = input.parentElement;
  if (!wrapper) return;

  const existing = wrapper.querySelector<HTMLElement>('.code-cells');
  const cells = existing ?? document.createElement('div');

  if (!existing) {
    cells.className = 'code-cells';
    cells.setAttribute('aria-hidden', 'true');

    // After the input, so `.code-input.error ~ .code-cells` can style the
    // cells from the input's own state. A sibling combinator works on every
    // browser an attendee might walk in with; `:has()` does not.
    input.insertAdjacentElement('afterend', cells);
    input.classList.add('code-input');
  }

  const render = () => {
    const { value } = input;
    const length = getLength(value);

    while (cells.childElementCount < length) {
      const cell = document.createElement('span');
      cell.className = 'code-cell';
      cells.append(cell);
    }
    while (cells.childElementCount > length) {
      cells.lastElementChild?.remove();
    }

    const focused = document.activeElement === input;

    for (const [i, cell] of [...cells.children].entries()) {
      cell.textContent = value[i] ?? '';
      cell.classList.toggle('filled', i < value.length);
      cell.classList.toggle('current', focused && i === value.length);
    }
  };

  /**
   * Keeps the caret at the end of the value.
   *
   * The input is invisible and stretched over the cells, so the offset a tap
   * produces bears no relation to the cell that was touched — it comes from
   * laying out text nobody can see. Collapsing to the end is the only position
   * the mirror can show honestly, and it is the one `render` already marks
   * `current`. It also rules out mid-string insertion, which `ui/inputs.ts`
   * would immediately garble by reassigning the formatted value.
   */
  const pinCaret = () => {
    const end = input.value.length;

    if (input.selectionStart === end && input.selectionEnd === end) return;

    input.setSelectionRange(end, end);
  };

  if (input.dataset[ATTACHED] !== 'true') {
    // `ui/inputs.ts` also listens for `input` and normalises the value there.
    // Attaching after it means this reads the formatted value, not the raw
    // keystroke — so the cells never briefly show a character the formatter is
    // about to strip.
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', render);

    input.addEventListener('focus', pinCaret);
    input.addEventListener('select', pinCaret);

    // iOS Safari places the caret after `click` has already run, so pinning
    // synchronously here would be overwritten a frame later.
    input.addEventListener('click', () => requestAnimationFrame(pinCaret));

    input.dataset[ATTACHED] = 'true';
  }

  render();
};
