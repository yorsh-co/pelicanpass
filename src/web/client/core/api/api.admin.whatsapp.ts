import { request } from './api.request.ts';

/**
 * The WhatsApp sender's calls.
 *
 * One function per endpoint, following `api.admin.attendees.ts`. The screen
 * itself is server-rendered; what crosses this module is a preview, a run
 * control, a test message, or the progress poll.
 */

/** One masked recipient in a preview sample. */
export interface PreviewRow {
  name: string;
  phone: string;
  state: 'new' | 'already_sent' | 'invalid_phone';
}

/** What a preview answers with. */
export interface RunPreview {
  previewToken: string;
  newRecipients: number;
  alreadySent: number;
  invalidPhone: number;
  total: number;
  estimatedCostUsd: number;
  rows: PreviewRow[];
}

/** A run's status, as both the poll and the controls report it. */
export type RunStatus = 'running' | 'paused' | 'done' | 'failed';

/** What the progress poll answers with, or `null` before the first run. */
export interface RunSummary {
  runId: string;
  templateKey: string;
  role: string;
  status: RunStatus;
  stopReason: string | null;
  total: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: {
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    skipped: number;
    deferred: number;
    interrupted: number;
    delivered: number;
    read: number;
  };
  spentUsd: number | null;
  failures: { errorTitle: string; count: number }[];
}

/** What a test send reports. A refusal from Meta is an answer, not an error. */
export type TestSendResult =
  | { sent: true; wamid: string; waId: string; differs: boolean }
  | { sent: false; code: number | null; classification: string; title: string };

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: T;
}

/**
 * Counts who a run would reach, and takes the token that confirms it.
 *
 * @param templateKey - Registry key, as rendered into the picker.
 * @param role - `participant` or `volunteer`.
 * @throws {ApiError} `VALIDATION_ERROR` if the template may not go to that role.
 */
export const preview = async (
  templateKey: string,
  role: string,
): Promise<RunPreview> => {
  const res = await request<Envelope<RunPreview>>(
    '/api/v1/admin/whatsapp/preview',
    { method: 'POST', json: { templateKey, role } },
  );

  if (!res.data) throw new Error('Preview returned no data');

  return res.data;
};

/**
 * Starts the run a preview described.
 *
 * @param templateKey - The previewed template.
 * @param role - The previewed audience.
 * @param previewToken - From {@link preview}. Single use.
 * @throws {ApiError} `CONFLICT` when the preview expired, the segment changed,
 *   a run is already active, or this server has sending switched off.
 */
export const startRun = async (
  templateKey: string,
  role: string,
  previewToken: string,
): Promise<{ runId: string; total: number }> => {
  const res = await request<Envelope<{ runId: string; total: number }>>(
    '/api/v1/admin/whatsapp/runs',
    { method: 'POST', json: { templateKey, role, previewToken } },
  );

  if (!res.data) throw new Error('Start returned no run');

  return res.data;
};

/** Pauses a running run. @param runId - Run to stop. */
export const stopRun = async (runId: string): Promise<void> => {
  await request(`/api/v1/admin/whatsapp/runs/${runId}/stop`, {
    method: 'POST',
  });
};

/** Resumes a paused run. @param runId - Run to resume. */
export const resumeRun = async (runId: string): Promise<void> => {
  await request(`/api/v1/admin/whatsapp/runs/${runId}/resume`, {
    method: 'POST',
  });
};

/**
 * Puts a run's interrupted rows back in the queue.
 *
 * @param runId - Run whose rows to re-queue.
 * @returns How many went back to pending.
 */
export const retryInterrupted = async (
  runId: string,
): Promise<{ queued: number }> => {
  const res = await request<Envelope<{ queued: number }>>(
    `/api/v1/admin/whatsapp/runs/${runId}/retry-interrupted`,
    { method: 'POST' },
  );

  return { queued: res.data?.queued ?? 0 };
};

/** Abandons a run so it stops blocking the event. @param runId - Run to cancel. */
export const cancelRun = async (runId: string): Promise<void> => {
  await request(`/api/v1/admin/whatsapp/runs/${runId}/cancel`, {
    method: 'POST',
  });
};

/**
 * Sends one template to a typed number, with placeholder values.
 *
 * @param templateKey - Template to send.
 * @param phone - Number as typed. Never reaches a URL.
 */
export const testSend = async (
  templateKey: string,
  phone: string,
): Promise<TestSendResult> => {
  const res = await request<Envelope<TestSendResult>>(
    '/api/v1/admin/whatsapp/test',
    { method: 'POST', json: { templateKey, phone } },
  );

  if (!res.data) throw new Error('Test send returned no result');

  return res.data;
};

/**
 * The progress poll.
 *
 * Its own limiter (`rl:session:admin:whatsapp`, 60/60 s) rather than the admin
 * budget, which a three-second poll would spend on its own.
 *
 * @returns The active run, else the most recent, or `null` if there is none.
 */
export const currentRun = async (): Promise<RunSummary | null> => {
  const res = await request<Envelope<RunSummary | null>>(
    '/api/v1/admin/whatsapp/runs/current',
  );

  return res.data ?? null;
};
