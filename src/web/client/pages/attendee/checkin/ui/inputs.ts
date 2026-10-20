import { logger } from '../../../../modules/log/logger.ts';

/** How a step reacts to what the attendee types. */
export interface InputHandlers {
  /** Submits the current value. */
  onInput: (options?: { fromPaste?: boolean }) => void | Promise<void>;

  /** Normalises the value on every keystroke. */
  formatValue: (value: string) => string;

  /** Whether the formatted value is worth submitting. */
  valueIsValid: (value: string) => boolean;
}

/**
 * Wires a step's input to its handlers: submit on Enter, debounced submit once
 * the value validates, an immediate submit on paste, and a fresh start on the
 * first character typed into a rejected field.
 *
 * Idempotent — the input is stamped with `data-initialized` so re-entering a
 * step does not stack a second set of listeners.
 *
 * @param input - The step's input element.
 * @param handlers - What to do with the value.
 */
export const setupInput = (
  input: HTMLInputElement | undefined,
  handlers: InputHandlers,
): void => {
  if (!input) {
    logger.error('ui', 'input missing');
    return;
  }

  input.value = '';
  input.disabled = false;

  if (input.dataset.initialized === 'true') return;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();

      void handlers.onInput();
    }
  });

  /**
   * The code a keystroke is about to start over from, or `null` when the
   * keystroke is an ordinary edit.
   *
   * Set on `beforeinput` and consumed by the `input` handler below, because
   * only the raw value that lands between those two events still carries the
   * new character — {@link InputHandlers.formatValue} is what discards it.
   */
  let replacing: string | null = null;

  // A rejected code stays in the field so the attendee can see what was wrong,
  // and both formatters cap the length — so without this the field silently
  // swallows every new keystroke.
  //
  // Only a rejection starts a new code: `ui/flow.ts` stamps
  // `data-reset-pending` on error. A full field without that stamp holds a
  // valid code still waiting on the debounced submit, so an extra keystroke is
  // a slip — the formatter drops it and the submit goes ahead. Backspace is left
  // alone, to walk back through what is there.
  input.addEventListener('beforeinput', (e) => {
    const pending = input.dataset.resetPending === 'true';

    delete input.dataset.resetPending;

    replacing =
      !e.inputType.startsWith('delete') && pending ? input.value : null;
  });

  let typingTimer: number | undefined;

  input.addEventListener('input', () => {
    clearTimeout(typingTimer);

    input.classList.remove('error');

    const raw = input.value;
    const started =
      replacing !== null && raw.startsWith(replacing)
        ? raw.slice(replacing.length)
        : raw;

    replacing = null;

    const formatted = handlers.formatValue(started);
    input.value = formatted;

    if (!handlers.valueIsValid(formatted)) return;

    typingTimer = setTimeout(() => void handlers.onInput(), 300);
  });

  input.addEventListener('paste', () => {
    setTimeout(() => {
      const formatted = handlers.formatValue(input.value);
      input.value = formatted;

      void handlers.onInput({ fromPaste: true });
    }, 0);
  });

  input.dataset.initialized = 'true';
};
