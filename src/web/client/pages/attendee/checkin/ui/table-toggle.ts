/** The elements one attendee-preview table toggle drives. */
export interface TableToggleElements {
  /** Button that collapses and expands the table. */
  toggle: HTMLButtonElement;

  /** Element carrying the `collapsed` class. */
  wrapper: HTMLElement;

  /** Material Symbols slot showing the current direction. */
  label: HTMLElement;
}

/**
 * Wires an attendee-preview table's collapse toggle and enables the button.
 *
 * Assigns `onclick` rather than adding a listener, so re-entering a step
 * replaces the handler instead of stacking another one.
 */
export const setupTableToggle = ({
  toggle,
  wrapper,
  label,
}: TableToggleElements): void => {
  toggle.onclick = () => {
    const isCollapsed = wrapper.classList.toggle('collapsed');

    /* copy-ok: icon ligature */
    label.textContent = isCollapsed
      ? 'keyboard_arrow_down'
      : 'keyboard_arrow_up';

    // The arrow is decorative and hidden from assistive tech, so the state has
    // to be carried by the button itself.
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
  };

  toggle.disabled = false;
};
