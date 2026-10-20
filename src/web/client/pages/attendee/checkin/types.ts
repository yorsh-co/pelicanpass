import type { CheckinStep } from '../../../../../types/checkin.ts';
import type { CheckinSessionView } from '../../../core/api/api.types.ts';
import type { TurnstileCaptcha } from '../../../components/captcha/captcha.ts';
import type {
  ErrorCopy,
  FlowOptions,
  QrCopy,
} from '../../../modules/qr/qr.types.ts';

/**
 * Shared types for the check-in page.
 *
 * This module exists to break a cycle, not to collect types for their own
 * sake. `state/step-config` imports all four step modules and `ui/navigation`,
 * and every one of them imports `step-config` back — the runtime graph is
 * genuinely circular, which ESM handles but which leaves no file to type
 * first. Declaring the shapes here lets each member of the cycle depend on
 * this module instead of on its neighbours.
 */

/**
 * The store's contents.
 *
 * Everything starts `null`: the page boots before the server's initial payload
 * has been read, and `ui/navigation` resets `session` to `{}` on lockout, so
 * the session is a partial view rather than a complete one.
 */
export interface CheckinState {
  currentUiStepKey: CheckinStep | null;
  captchaRequired: boolean | null;
  isSkeleton: boolean | null;
  session: Partial<CheckinSessionView> | null;
  audienceHint: string | null;
}

/** Visual states a step can be driven through by `ui/flow`. */
export type FlowState = 'idle' | 'processing' | 'success' | 'error' | 'hidden';

/** The controls `createStepFlow` hands back for one step. */
export interface StepFlow {
  transition(
    state: FlowState,
    payload?: [string | null, FlowOptions?] | string | null,
  ): Promise<void>;

  idle(msg?: string | null, options?: FlowOptions): Promise<void>;
  processing(msg?: string | null, options?: FlowOptions): Promise<void>;
  success(msg?: string | null): Promise<void>;
  error(msg?: string | null, options?: FlowOptions): Promise<void>;
  hidden(msg?: string | null, options?: FlowOptions): Promise<void>;
}

/** Elements a step flow drives. Only `step` and `hint` are always present. */
export interface StepFlowElements {
  step: HTMLElement;
  hint: HTMLElement;
  input?: HTMLInputElement;
  btn?: HTMLButtonElement;
  focusTarget?: HTMLInputElement;
}

// Moved to modules/qr/qr.types.ts when the staff scanner became the second caller
// of `setupQr`: a shared module cannot import from one page's types. Imported
// and re-exported rather than only re-exported, because this file uses
// `ErrorCopy` itself — a bare `export … from` publishes a name without binding
// it locally.
export type { ErrorCopy, FlowOptions, QrCopy };

/**
 * The strings of the volunteer-confirmation button on the QR step, which only
 * the attendee's scanner has: the staff scanner shares {@link QrCopy} and has
 * no such button.
 */
export interface PresenceCopy {
  /** Label of the button. */
  presenceButton: string;
  /** Staff have not confirmed the attendee yet. */
  presenceNotYet: string;
  /** Any other failure of the confirmation check. */
  presenceError: string;
}

/** Every string the check-in page can display, for one audience. */
export interface AudienceCopy {
  init: {
    error: ErrorCopy;
    unknownError: string;
    recoverableError: string;
  };

  captcha: {
    missing: string;
    expired: string;
  };

  ticket: {
    header: string;
    defaultHint: string;
    empty: string;
    invalidCode: string;
    invalidFormat: string;
    processing: string;
    success: string;
    error: ErrorCopy;
    unknownError: string;
  };

  verification: {
    header: string;
    backButton: string;
    defaultHint: string;
    processing: string;
    success: string;
    error: ErrorCopy;
    unknownError: string;
  };

  qr: QrCopy & PresenceCopy;

  userPreview: {
    ticketLabel: string;
    nameLabel: string;
    phoneLabel: string;
  };

  success: {
    /** Greets the attendee by first name. */
    greeting: (name: string) => string;
    /** Used when the preview carried no name to greet with. */
    greetingFallback: string;
    numberLabel: string;
    success: string;
    redirect: string;
    help: string;
  };

  lockout: {
    rateLimit: string;
  };
}

/**
 * One entry of `state/step-config`.
 *
 * Most members are optional because the four steps genuinely differ: `ticket`
 * owns the captcha and has no back button, `qr` has a button but no input, and
 * `success` is a terminal step with no flow, no transitions out and no exit.
 * `ui/navigation` already guards each one before calling it.
 */
export interface StepConfig<TCopy = unknown> {
  /** Steps reachable from this one. Absent on a terminal step. */
  next?: CheckinStep[];

  step: HTMLElement;
  hint?: HTMLElement;
  input?: HTMLInputElement;
  btn?: HTMLButtonElement;
  focusTarget?: HTMLInputElement;
  captcha?: TurnstileCaptcha;

  /** Lazily built by `getFlow`, cached for the life of the page. */
  _flow?: StepFlow;

  /** The step's copy for the current audience. */
  getCopy(): TCopy;

  getFlow?(): StepFlow;

  /**
   * Both may run synchronously. `success` is the only step that awaits
   * anything on entry; the others hand their flow transitions off without
   * waiting, so that the step swap is not gated on a hint animation.
   */
  onEnter?(
    state: CheckinState,
    options: { skeleton: boolean },
  ): void | Promise<void>;
  onExit?(): void | Promise<void>;
}

/** A step that owns a flow. Everything the flow drives is present. */
export interface FlowStepConfig<TCopy> extends StepConfig<TCopy> {
  hint: HTMLElement;
  getFlow(): StepFlow;
}

export interface TicketStepConfig extends FlowStepConfig<
  AudienceCopy['ticket']
> {
  input: HTMLInputElement;
  focusTarget: HTMLInputElement;
  captcha: TurnstileCaptcha;
}

export interface VerificationStepConfig extends FlowStepConfig<
  AudienceCopy['verification']
> {
  input: HTMLInputElement;
  focusTarget: HTMLInputElement;
  btn: HTMLButtonElement;
}

export interface QrStepConfig extends FlowStepConfig<AudienceCopy['qr']> {
  btn: HTMLButtonElement;
}

/**
 * The step table.
 *
 * Each entry keeps its own narrow type, which is what spares the step modules
 * a null check on every element their own step already declares.
 */
export interface StepConfigMap {
  ticket: TicketStepConfig;
  verification: VerificationStepConfig;
  qr: QrStepConfig;
  success: StepConfig<AudienceCopy['success']>;
}

/**
 * The same table seen by key.
 *
 * `ui/navigation` looks a step up by a `CheckinStep` the server chose, which
 * may be `init` or any step with no entry — hence the partial record, which is
 * what makes navigation's `if (!nextStep)` guard meaningful rather than dead.
 */
export type StepConfigByKey = Partial<Record<CheckinStep, StepConfig>>;
