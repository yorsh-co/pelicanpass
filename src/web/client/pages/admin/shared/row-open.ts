/** Elements that handle their own clicks and must not be hijacked. */
const CONTROLS = 'button, a, input, label, select, textarea, summary';

/**
 * Presses a row's open button when the click was meant for the row.
 *
 * @param row - The row that was clicked.
 * @param event - The click.
 */
const openRow = (row: HTMLElement, event: MouseEvent): void => {
  // The button submits on its own. Pressing it again from here would send the
  // form twice.
  if (event.target instanceof Element && event.target.closest(CONTROLS)) return;

  // Dragging across a cell's text to copy it ends in a click on the row, and
  // is not a request to go anywhere.
  if ((window.getSelection()?.toString() ?? '') !== '') return;

  row.querySelector<HTMLButtonElement>('.admin-table__open')?.click();
};

/**
 * Lets a click anywhere in a row open its record, by pressing the
 * `.admin-table__open` button the template rendered in it. Rows without one,
 * such as a breakdown's, are left inert.
 *
 * The button is a submit button in a form, so opening a record works without
 * this: the screen loses a convenience, not a capability.
 *
 * **It carries no attendee ID of its own.** The template renders that value
 * once, on the button; finding the button is cheaper than a second copy of it
 * in a data attribute, and cannot fall out of step with the first.
 *
 * @param rows - The rows to wire.
 */
export const openRowsOnClick = (rows: Iterable<HTMLElement>): void => {
  for (const row of rows) {
    row.addEventListener('click', (event) => {
      openRow(row, event);
    });
  }
};
