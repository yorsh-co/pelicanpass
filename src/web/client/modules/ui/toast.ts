import { logger } from '../log/logger.ts';
import utils from '../utils/index.ts';

const LEVELS = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

/** Severity of a toast, which also selects its icon and CSS class. */
export type ToastLevel = keyof typeof LEVELS;

const MIN_LEVEL: ToastLevel = 'info';

/** Every level class, so showing one toast can clear the last one's. */
const LEVEL_CLASSES = Object.keys(LEVELS);

/**
 * Which toast currently owns the shared element.
 *
 * Every toast is a separate instance over the same markup, and both `show` and
 * `remove` await an animation before touching it. Without this counter, a
 * toast dismissed on its own timer would blank the text of whichever toast
 * replaced it in the meantime.
 */
let activeToast = 0;

const ICONS: Record<ToastLevel, string> = {
  debug: 'bug_report',
  info: 'info',
  success: 'check',
  warn: 'warning',
  error: 'error',
};

/** Constructor options for {@link Toast}. */
interface ToastOptions {
  /** Milliseconds before the toast auto-dismisses. `0` keeps it up. */
  duration?: number;

  /** Selector for the toast element, if not the layout's shared one. */
  elementQuery?: string;

  /** Material Symbols icon name, if not the one implied by the level. */
  icon?: string;
}

export class Toast {
  readonly level: ToastLevel;
  readonly msg: string;
  readonly duration: number;
  readonly elementQuery: string;
  readonly icon: string;

  /**
   * The toast element, or `null` when the page has no toast markup. Every
   * method checks it rather than throwing, so a missing toast degrades to
   * silence instead of taking the caller down with it.
   */
  readonly toastEl: HTMLElement | null;

  /** Icon and message slots inside {@link toastEl}. */
  readonly iconEl: HTMLElement | null;
  readonly msgEl: HTMLElement | null;

  constructor(level: ToastLevel, msg: string, options: ToastOptions = {}) {
    this.level = level;
    this.msg = msg;

    this.duration = options.duration ?? 5000;
    this.elementQuery = options.elementQuery ?? '[data-main="toast"]';
    this.icon = options.icon ?? ICONS[level];

    this.toastEl = document.querySelector(this.elementQuery);
    if (!this.toastEl) {
      logger.error('toast', `element not found: ${this.elementQuery}`);
      this.iconEl = null;
      this.msgEl = null;
      return;
    }

    this.iconEl = this.toastEl.querySelector('[data-toast="icon"]');
    this.msgEl = this.toastEl.querySelector('[data-toast="msg"]');
  }

  /**
   * Displays the toast, then schedules its removal.
   *
   * @param duration - Overrides the duration given at construction.
   * @returns The toast, or `undefined` if it was suppressed or has no element.
   */
  async show(duration: number = this.duration): Promise<this | undefined> {
    if (LEVELS[this.level] < LEVELS[MIN_LEVEL]) return undefined;

    const { toastEl, iconEl, msgEl } = this;

    if (!toastEl) {
      logger.error('toast', `element not found: ${this.elementQuery}`);
      return undefined;
    }

    const token = ++activeToast;

    if (iconEl) iconEl.textContent = this.icon;
    if (msgEl) msgEl.textContent = this.msg;

    await utils.sleep(400);

    if (token !== activeToast) return undefined;

    toastEl.classList.remove(...LEVEL_CLASSES);
    toastEl.classList.add(this.level, 'show');

    if (duration > 0) {
      setTimeout(() => {
        if (token === activeToast) void this.remove();
      }, duration);
    }

    return this;
  }

  async remove(): Promise<void> {
    const { toastEl, iconEl, msgEl } = this;

    if (!toastEl) return;

    const token = activeToast;

    toastEl.classList.remove('show');

    await utils.sleep(600);

    if (token !== activeToast) return;

    if (iconEl) iconEl.textContent = '';
    if (msgEl) msgEl.textContent = '';

    toastEl.classList.remove(this.level);
  }
}

/** Storage key for the toast handed across a navigation. */
const DEFERRED_KEY = 'toast:deferred';

/**
 * How long a deferred toast stays claimable. Long enough for a slow POST to
 * render the next page, short enough that a navigation which never arrived —
 * an expired session bounced to the login page, an edge challenge — does not
 * leave a confirmation for some later, unrelated page to show.
 */
const DEFERRED_TTL_MS = 10_000;

/**
 * Hands a toast to the next page load.
 *
 * For an action that navigates as soon as it succeeds: a toast shown before
 * the navigation is destroyed with the page. Only a key is stored, never the
 * message, so no copy — and nothing about the record it names — is written to
 * storage, and the next page renders it in its own locale.
 *
 * `sessionStorage` throws in some webview privacy modes. The confirmation is
 * then lost, which is the behaviour without it, not a failed action.
 *
 * @param key - Message key the destination page knows how to render.
 */
export const deferToast = (key: string): void => {
  try {
    window.sessionStorage.setItem(
      DEFERRED_KEY,
      JSON.stringify({ key, at: Date.now() }),
    );
  } catch {
    // Storage is unavailable; the page still navigates.
  }
};

/**
 * Claims the toast deferred by the previous page, if any.
 *
 * Removed on read, so a reload, a resubmission or a back navigation never
 * shows it twice.
 *
 * @returns The deferred key, or `null` when there is none or it has expired.
 */
export const takeDeferredToast = (): string | null => {
  try {
    const raw = window.sessionStorage.getItem(DEFERRED_KEY);

    if (raw === null) return null;

    window.sessionStorage.removeItem(DEFERRED_KEY);

    const { key, at } = JSON.parse(raw) as { key?: unknown; at?: unknown };

    if (typeof key !== 'string' || typeof at !== 'number') return null;

    return Date.now() - at <= DEFERRED_TTL_MS ? key : null;
  } catch {
    return null;
  }
};

const toast = {
  debug: (msg: string, options?: ToastOptions) =>
    new Toast('debug', msg, options).show(),
  info: (msg: string, options?: ToastOptions) =>
    new Toast('info', msg, options).show(),
  success: (msg: string, options?: ToastOptions) =>
    new Toast('success', msg, options).show(),
  warn: (msg: string, options?: ToastOptions) =>
    new Toast('warn', msg, options).show(),
  error: (msg: string, options?: ToastOptions) =>
    new Toast('error', msg, options).show(),
};

export default toast;
