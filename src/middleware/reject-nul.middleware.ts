import type { RequestHandler } from 'express';

import { ValidationError } from '../shared/errors/app-error.ts';

/**
 * Whether any string in a value, an object key included, holds `\u0000`.
 *
 * Iterative: a 10 kB JSON body can nest several thousand arrays deep, which a
 * recursive walk would turn into a stack overflow.
 *
 * @param root - A parsed body or query: strings, arrays and plain objects.
 */
const containsNul = (root: unknown): boolean => {
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();

    if (typeof value === 'string') {
      if (value.includes('\u0000')) return true;
    } else if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes('\u0000')) return true;

        pending.push(child);
      }
    }
  }

  return false;
};

/**
 * Refuses a request with `\u0000` anywhere in its parsed body or query string.
 *
 * Postgres rejects the byte in `text` and `jsonb` alike, so one that reaches a
 * query answers 500, logs an error and counts toward the 5xx alert, for what is
 * the client's malformed input. Refusing it here covers every field, present
 * and future, instead of each repository cleaning its own.
 *
 * Mount it after the body parser, which is what it reads. A router that has no
 * parser yet (a query-only check) may mount it earlier: `req.body` is then
 * undefined and ignored.
 *
 * Not mounted ahead of the WhatsApp webhook, whose body is Meta's signed raw
 * JSON, nor `/client-errors`, which strips the byte instead.
 */
export const rejectNulInput: RequestHandler = (req, _res, next) => {
  if (containsNul(req.query) || containsNul(req.body)) {
    return next(new ValidationError('Request contains a NUL character'));
  }

  next();
};
