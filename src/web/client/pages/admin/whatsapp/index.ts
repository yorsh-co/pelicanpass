import api from '../../../core/api/index.ts';
import toast from '../../../modules/ui/toast.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import { logger } from '../../../modules/log/logger.ts';
import { qsOptional } from '../../../layouts/main/dom.ts';
import { startPollLoop } from '../../../modules/ui/poll-loop.ts';
import { SENDER_COPY } from './messages.ts';
import { refusalMessage } from '../shared/refusal.ts';

import type { PollLoop } from '../../../modules/ui/poll-loop.ts';
import type {
  RunPreview,
  RunSummary,
  TestSendResult,
} from '../../../core/api/api.admin.whatsapp.ts';

/**
 * The WhatsApp sender: previewing a segment, testing one number, starting a
 * run and watching it.
 *
 * Every form keeps `method="post"` even though this handler cancels the native
 * submit, for the reason the record form gives: without it the Enter key
 * submits as **GET**, and a typed phone number would reach the request log
 * through the URL. If this bundle fails to load, the uncancelled submit is a
 * re-render of the same page rather than a leak.
 *
 * The screen is server-rendered first, so what is here replaces numbers in
 * place rather than building the page.
 */

/** How often the progress region refreshes while a run is going. */
const POLL_MS = 3_000;

/** Counts the progress region shows, in the order the panel lists them. */
const COUNT_KEYS = [
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'deferred',
  'interrupted',
  'pending',
] as const;

/** A run in one of these is finished with, so the poll stops. */
const TERMINAL: RunSummary['status'][] = ['done', 'failed'];

const pick = (name: string): HTMLElement | null =>
  qsOptional(`[data-whatsapp="${name}"]`);

/**
 * Reads one field off a form as a string.
 *
 * `FormData.get` answers `string | File | null`, and stringifying a File yields
 * `[object Object]` — a value the server would dutifully try to validate. No
 * field here is a file, so anything that is not a string is treated as absent.
 * The record form's `readFields` says the same thing for the same reason.
 *
 * @param form - Form to read.
 * @param name - Field name.
 */
const readField = (form: HTMLFormElement, name: string): string => {
  const value = new FormData(form).get(name);

  return typeof value === 'string' ? value : '';
};

/**
 * Puts a refusal where the operator is looking.
 *
 * `VALIDATION_ERROR` and `CONFLICT` are shown by their reason: one `CONFLICT`
 * code covers several different refusals — an expired preview, a changed list,
 * a run already in progress, sending switched off — and `details.reason` tells
 * them apart.
 *
 * @param err - Whatever the call threw.
 * @param slot - The panel's error line.
 * @param fallback - Line to show when the code carries no message of its own.
 */
const reportError = (
  err: unknown,
  slot: HTMLElement | null,
  fallback: string = SENDER_COPY.failed,
): void => {
  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      window.location.assign('/admin/login');

      return;
    }

    if (err.code === 'VALIDATION_ERROR' || err.code === 'CONFLICT') {
      if (slot) slot.textContent = refusalMessage(err) ?? fallback;

      return;
    }

    if (err.code === 'FORBIDDEN') {
      if (slot) slot.textContent = SENDER_COPY.forbidden;

      return;
    }
  }

  logger.warn('admin', err instanceof Error ? err.message : 'Request failed');

  if (slot) slot.textContent = fallback;
};

/** The run being watched, and the loop watching it. */
let runId = pick('run')?.dataset.runId ?? '';
let loop: PollLoop | null = null;

/** The token the confirm control replays, held here and never in the DOM. */
let previewToken = '';

/**
 * Paints one run summary over the progress region.
 *
 * @param run - What the poll answered with.
 */
const renderRun = (run: RunSummary | null): void => {
  const region = pick('run');

  if (!region) return;

  if (!run) {
    region.hidden = true;

    return;
  }

  region.hidden = false;
  region.dataset.runId = run.runId;
  region.dataset.status = run.status;
  runId = run.runId;

  const status = pick('status');

  if (status) status.textContent = SENDER_COPY.status(run);

  const total = pick('total');

  if (total) total.textContent = String(run.total);

  const spent = pick('spent');

  if (spent) {
    spent.hidden = run.spentUsd === null;
    spent.textContent =
      run.spentUsd === null ? '' : SENDER_COPY.runSpent(run.spentUsd);
  }

  for (const key of COUNT_KEYS) {
    const slot = pick(`count-${key}`);

    if (slot) slot.textContent = String(run.counts[key]);
  }

  const failures = pick('failures');

  if (failures) {
    failures.replaceChildren(
      ...run.failures.map((failure) => {
        const row = document.createElement('tr');
        const title = document.createElement('th');
        const count = document.createElement('td');

        title.scope = 'row';
        title.textContent = SENDER_COPY.failure(failure.errorTitle);
        count.textContent = String(failure.count);

        row.append(title, count);

        return row;
      }),
    );
  }

  const empty = pick('failures-empty');

  if (empty) empty.hidden = run.failures.length > 0;
};

/**
 * Starts watching a run, unless it is already finished.
 *
 * A fresh loop each time rather than one kept around: `suspend` is one-way, and
 * a run that ends while the page stays open is the ordinary case.
 *
 * @param run - The run to watch.
 */
const watch = (run: RunSummary | null): void => {
  renderRun(run);

  if (!run || TERMINAL.includes(run.status) || loop) return;

  loop = startPollLoop<RunSummary | null>({
    fetch: () => api.admin.whatsapp.currentRun(),
    render: (payload) => {
      renderRun(payload);

      if (!payload || !TERMINAL.includes(payload.status)) return;

      loop?.suspend();
      loop = null;

      if (payload.status === 'done') void toast.success(SENDER_COPY.done);
      else void toast.info(SENDER_COPY.stopped);
    },
    // The three states the loop reports are about the poll, not the run: they
    // say whether these numbers are still being refreshed.
    setState: (state) => {
      const region = pick('run');

      if (region) region.dataset.poll = state;
    },
    tick: () => undefined,
    intervalMs: POLL_MS,
  });
};

/** Wires the preview form. */
const setupPreview = (): void => {
  const form = qsOptional<HTMLFormElement>('[data-whatsapp="preview-form"]');

  if (!form) return;

  const slot = pick('preview-error');
  const result = pick('preview-result');
  const confirm = qsOptional<HTMLButtonElement>('[data-whatsapp="confirm"]');
  const confirmLabel = pick('confirm-label');

  const paint = (preview: RunPreview, templateLabel: string): void => {
    previewToken = preview.previewToken;

    const counts = pick('preview-counts');

    if (counts) counts.textContent = SENDER_COPY.previewCounts(preview);

    const cost = pick('preview-cost');

    if (cost) cost.textContent = SENDER_COPY.previewCost(preview);

    const rows = pick('preview-rows');

    if (rows) {
      rows.replaceChildren(
        ...preview.rows.map((row) => {
          const item = document.createElement('li');

          item.textContent = `${row.name} · ${row.phone}…`;
          item.dataset.state = row.state;

          return item;
        }),
      );
    }

    const more = pick('preview-more');

    if (more) {
      const shown = preview.rows.length;

      more.hidden = shown >= preview.total;
      more.textContent = SENDER_COPY.previewMore(shown, preview.total);
    }

    if (result) result.hidden = false;

    if (confirm) {
      confirm.disabled =
        preview.newRecipients === 0 ||
        confirm.dataset.sendingEnabled !== 'true';
    }

    if (confirmLabel) {
      confirmLabel.textContent = SENDER_COPY.confirmTo(
        templateLabel,
        preview.newRecipients,
      );
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    void (async () => {
      if (slot) slot.textContent = '';

      const templateKey = readField(form, 'templateKey');
      const role = readField(form, 'role');

      // `option.text` rather than `textContent`: it is typed as a string, so
      // the label needs no chain of guards to become one.
      const option =
        qsOptional<HTMLSelectElement>('#templateKey')?.selectedOptions[0];
      const templateLabel = option ? option.text.trim() : templateKey;

      try {
        paint(
          await api.admin.whatsapp.preview(templateKey, role),
          templateLabel,
        );
      } catch (err) {
        previewToken = '';

        if (confirm) confirm.disabled = true;

        reportError(err, slot, SENDER_COPY.previewFailed);
      }
    })();
  });
};

/**
 * Whether a start that failed on the wire actually started its run, and if so
 * picks the run up as a success would.
 *
 * A timeout leaves the start unknown, and a re-press after one that went
 * through is refused `previewExpired`, because the token was spent. Either way
 * the current run says what happened: a run other than the one on screen
 * before the press is this one.
 *
 * @param err - What the start threw.
 * @param knownRunId - The run on screen before the press, or `''` for none.
 * @returns True when the run had started and is now being watched.
 */
const startedAnyway = async (
  err: unknown,
  knownRunId: string,
): Promise<boolean> => {
  const unknown =
    err instanceof ApiError &&
    (err.code === 'EDGE_TIMEOUT' ||
      (err.code === 'CONFLICT' && err.details?.reason === 'previewExpired'));

  if (!unknown) return false;

  try {
    const run = await api.admin.whatsapp.currentRun();

    if (!run || run.runId === knownRunId) return false;

    previewToken = '';
    watch(run);
    void toast.success(SENDER_COPY.started);

    return true;
  } catch (readErr) {
    logger.warn('admin', 'run check after a failed start failed', {
      err: readErr,
    });

    return false;
  }
};

/** Wires the confirm control, which starts the run. */
const setupConfirm = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-whatsapp="confirm"]');

  if (!button) return;

  const slot = pick('preview-error');
  const form = qsOptional<HTMLFormElement>('[data-whatsapp="preview-form"]');

  button.addEventListener('click', () => {
    void (async () => {
      if (!previewToken || !form) return;

      button.disabled = true;

      // The run on screen before this start, to tell a new one from it.
      const knownRunId = runId;

      try {
        await api.admin.whatsapp.startRun(
          readField(form, 'templateKey'),
          readField(form, 'role'),
          previewToken,
        );

        // Spent either way: the server deletes it as it reads it, so a second
        // press could only ever be refused.
        previewToken = '';

        watch(await api.admin.whatsapp.currentRun());

        void toast.success(SENDER_COPY.started);
      } catch (err) {
        if (await startedAnyway(err, knownRunId)) return;

        reportError(err, slot, SENDER_COPY.startFailed);
      }
    })();
  });
};

/** Wires the test send. */
const setupTest = (): void => {
  const form = qsOptional<HTMLFormElement>('[data-whatsapp="test-form"]');

  if (!form) return;

  const slot = pick('test-error');
  const result = pick('test-result');

  const describe = (outcome: TestSendResult): string => {
    if (!outcome.sent) {
      return SENDER_COPY.testRefused(outcome.title, outcome.code);
    }

    return outcome.differs
      ? SENDER_COPY.testSentNormalized(outcome.waId)
      : SENDER_COPY.testSentUnchanged;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    void (async () => {
      if (slot) slot.textContent = '';
      if (result) result.textContent = '';

      try {
        const outcome = await api.admin.whatsapp.testSend(
          readField(form, 'templateKey'),
          readField(form, 'phone'),
        );

        if (result) result.textContent = describe(outcome);
      } catch (err) {
        reportError(err, slot, SENDER_COPY.testFailed);
      }
    })();
  });
};

/**
 * Wires the four run controls.
 *
 * Each refreshes the region from the server rather than guessing the new state:
 * the run may have moved on between the click and the answer.
 */
const setupControls = (): void => {
  const slot = pick('run-error');

  const actions: Record<string, (id: string) => Promise<unknown>> = {
    stop: api.admin.whatsapp.stopRun,
    resume: api.admin.whatsapp.resumeRun,
    'retry-interrupted': api.admin.whatsapp.retryInterrupted,
    cancel: api.admin.whatsapp.cancelRun,
  };

  for (const [name, call] of Object.entries(actions)) {
    const button = qsOptional<HTMLButtonElement>(`[data-whatsapp="${name}"]`);

    if (!button) continue;

    button.addEventListener('click', () => {
      void (async () => {
        if (!runId) return;

        if (slot) slot.textContent = '';

        button.disabled = true;

        try {
          const outcome = await call(runId);

          if (name === 'retry-interrupted') {
            const queued = (outcome as { queued: number }).queued;

            void toast.success(SENDER_COPY.requeued(queued));
          }

          watch(await api.admin.whatsapp.currentRun());
        } catch (err) {
          reportError(err, slot);
        }

        button.disabled = false;
      })();
    });
  }
};

setupPreview();
setupConfirm();
setupTest();
setupControls();

// The first paint already carries the run; this only starts the loop if it is
// still going.
if (runId) void api.admin.whatsapp.currentRun().then(watch);
