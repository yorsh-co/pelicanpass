/**
 * Keeps the administrator screens read-only in the demo.
 *
 * Their forms post to routes the static host cannot serve, and their scripts
 * mutate through the API the mock already refuses. This module covers the
 * first half: it cancels a form submission before any page script sees it and
 * tells the visitor why, except for the forms that only open a record, which
 * navigate to the page that stands for it. It works in both language trees:
 * the paths it classifies are the plain ones, and a navigation stays in the
 * tree the page is in.
 */

import { localizedPath, stripTree } from './locale-route.ts';

import type { DemoLocale } from './locale-route.ts';

/** Which of the two demo notices to show. */
export type NoticeKey = 'disabled' | 'unavailable';

/* eslint-disable no-restricted-syntax -- demo-only copy, not in the app's catalogs */

/** Demo-only copy, in each language the demo is served in. */
export const NOTICES: Record<DemoLocale, Record<NoticeKey, string>> = {
  'pt-BR': {
    disabled: 'Alterações estão desativadas na demonstração.',
    unavailable: 'Esta ação não está disponível na demonstração.',
  },
  en: {
    disabled: 'Changes are disabled in the demo.',
    unavailable: 'This action is not available in the demo.',
  },
};

/* eslint-enable no-restricted-syntax */

/**
 * The language a page's notices are written in.
 *
 * @param lang - `document.documentElement.lang`. English for `en` and its
 *   regional forms, pt-BR for anything else.
 */
export const noticeLocale = (lang: string): DemoLocale =>
  lang.toLowerCase().split('-')[0] === 'en' ? 'en' : 'pt-BR';

/** What to do with a submitted form. */
export type FormVerdict =
  | { kind: 'ignore' }
  | { kind: 'navigate'; to: string }
  | { kind: 'refuse'; notice: NoticeKey };

/** The parts of a submission the verdict depends on. */
export interface FormSubmission {
  /**
   * Pathname the form posts to, resolved against the page and without the
   * English tree's `/en` prefix.
   */
  path: string;

  /** Submission method, any case. */
  method: string;

  /** The form's `id`; the search forms are the ones named `filters`. */
  id: string;
}

/**
 * Forms that post a lookup to open a record. The build rewrites the path to the
 * fixture page that stands for the record (`_redirects`), so a GET opens it.
 */
const RECORD_PATHS: ReadonlySet<string> = new Set([
  '/admin/lookup/record',
  '/admin/redemptions/record',
  '/admin/tshirts/record',
  '/admin/volunteers/record',
]);

/**
 * Paths whose pages the demo does not ship: the attendee editor. Opening one
 * is not a change, but there is nothing to open.
 */
const UNSHIPPED_PATHS: ReadonlySet<string> = new Set([
  '/admin/attendees/new',
  '/admin/attendees/edit',
]);

/**
 * Decides what a submission is.
 *
 * Only forms posting under `/admin` are of interest; a `GET` form is a plain
 * navigation and a public page's form belongs to the mock API. Everything else
 * under `/admin` is a mutation, or a search the static pages cannot answer.
 *
 * @param submission - The form's resolved target, in the plain tree, and its
 *   identity.
 * @returns Whether to leave it alone, navigate, or cancel it with a notice.
 */
export const classifyForm = ({
  path,
  method,
  id,
}: FormSubmission): FormVerdict => {
  const target = path.length > 1 ? path.replace(/\/+$/, '') : path;

  if (['GET', 'DIALOG'].includes(method.toUpperCase())) {
    return { kind: 'ignore' };
  }

  if (target !== '/admin' && !target.startsWith('/admin/')) {
    return { kind: 'ignore' };
  }

  if (RECORD_PATHS.has(target)) return { kind: 'navigate', to: target };

  if (UNSHIPPED_PATHS.has(target) || id === 'filters') {
    return { kind: 'refuse', notice: 'unavailable' };
  }

  return { kind: 'refuse', notice: 'disabled' };
};

/**
 * Shows a demo notice in the page's own toast.
 *
 * The toast module reads the document body when it loads, which this script,
 * running in `<head>`, precedes; it is therefore imported on first use.
 *
 * @param notice - Which notice to show.
 */
export const showNotice = async (notice: NoticeKey): Promise<void> => {
  const { default: toast } = await import('../modules/ui/toast.ts');

  await toast.info(
    NOTICES[noticeLocale(document.documentElement.lang)][notice],
  );
};

/** The form and submitter attributes that decide where and how it posts. */
const submissionOf = (event: SubmitEvent, form: HTMLFormElement) => {
  const { submitter } = event;
  const action =
    submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '';
  const method =
    submitter?.getAttribute('formmethod') ??
    form.getAttribute('method') ??
    'get';

  return {
    url: new URL(action, window.location.href),
    method,
    id: form.id,
  };
};

/**
 * Listens for form submissions in the capture phase, so the page's own
 * handlers never run for a form the demo refuses.
 */
export const installAdminGuard = (): void => {
  document.addEventListener(
    'submit',
    (event) => {
      if (!(event.target instanceof HTMLFormElement)) return;

      const { url, method, id } = submissionOf(event, event.target);

      if (url.origin !== window.location.origin) return;

      const verdict = classifyForm({
        path: stripTree(url.pathname),
        method,
        id,
      });

      if (verdict.kind === 'ignore') return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (verdict.kind === 'navigate') {
        window.location.assign(
          localizedPath(window.location.pathname, verdict.to),
        );
      } else {
        void showNotice(verdict.notice);
      }
    },
    true,
  );
};
