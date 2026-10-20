import ui from '../../../../modules/ui/index.ts';
import { isDesktop } from '../../../../modules/utils/browser/viewport.ts';
import { FLOW_COPY } from './messages.ts';

import type {
  FlowOptions,
  FlowState,
  StepFlow,
  StepFlowElements,
} from '../types.ts';

/**
 * Builds the visual-state controls for one step: which of its elements are
 * disabled, focused, marked busy, and what its hint says.
 *
 * @param els - The step's elements. Only `step` and `hint` are required; a
 *   step without an input or a button simply skips those branches.
 */
export const createStepFlow = (els: StepFlowElements): StepFlow => {
  const resolveTarget = (override?: Element) => override ?? els.step;

  const transitions: Record<
    FlowState,
    (msg?: string | null, options?: FlowOptions) => Promise<void>
  > = {
    idle: async (msg = null, options = {}) => {
      const { input, btn, hint, focusTarget } = els;

      const target = resolveTarget(options.target);

      ui.element.setProcessing(target, false);

      if (input) {
        input.disabled = false;
        input.classList.remove('error');
      }

      if (btn) {
        btn.disabled = false;
      }

      if (focusTarget && isDesktop()) {
        focusTarget.focus();
      }

      if (msg) await ui.hint.showHint(hint, msg);
      else if (!options.keepHint) await ui.hint.clear(hint);
    },

    processing: async (msg = FLOW_COPY.processing, options = {}) => {
      const { input, btn, hint } = els;

      const target = resolveTarget(options.target);

      ui.element.setProcessing(target, true);

      if (input) {
        input.disabled = true;
        input.blur();
      }

      if (btn) {
        btn.disabled = true;
      }

      // An explicit null clears the hint; the default above only covers
      // undefined.
      await ui.hint.showHint(hint, msg ?? '');
    },

    success: async (msg) => {
      const { hint } = els;

      if (msg) await ui.hint.showHint(hint, msg);
    },

    error: async (msg = FLOW_COPY.error, options = {}) => {
      const { input, btn, hint, focusTarget } = els;

      const target = resolveTarget(options.target);

      ui.element.setProcessing(target, false);

      if (input) {
        input.classList.add('error');
        input.disabled = false;

        // The rejected code stays visible, but the next character typed
        // replaces it rather than being swallowed by the length cap. Read and
        // cleared in `ui/inputs.ts`.
        input.dataset.resetPending = 'true';
      }

      if (btn) {
        btn.disabled = false;
      }

      if (focusTarget) {
        focusTarget.focus();
      }

      await ui.hint.showError(hint, msg ?? '');
    },

    hidden: async (_msg, options = {}) => {
      const { input, btn, hint } = els;

      const target = resolveTarget(options.target);

      ui.element.setProcessing(target, false);

      if (input) {
        input.value = '';
        input.classList.remove('error');
        input.disabled = true;
        input.blur();
      }

      if (btn) {
        btn.disabled = true;
      }

      await ui.hint.clear(hint);
    },
  };

  /**
   * Dispatches to one transition. `payload` is either the pair the named
   * helpers below pass, or a bare message.
   */
  const transition = async (
    state: FlowState,
    payload?: [string | null, FlowOptions?] | string | null,
  ): Promise<void> => {
    const fn = transitions[state];

    if (Array.isArray(payload)) {
      await fn(payload[0], payload[1]);
    } else {
      await fn(payload);
    }
  };

  return {
    transition,

    idle: async (msg = null, options = {}) =>
      transition('idle', [msg, options]),
    processing: async (msg = null, options = {}) =>
      transition('processing', [msg, options]),
    success: async (msg = null) => transition('success', msg),
    error: async (msg = null, options = {}) =>
      transition('error', [msg, options]),
    hidden: async (msg = null, options = {}) =>
      transition('hidden', [msg, options]),
  };
};
