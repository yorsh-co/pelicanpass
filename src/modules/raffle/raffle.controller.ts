import type { RequestHandler } from 'express';

import { RaffleService } from './raffle.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

/**
 * Reads the repeats toggle off a request body.
 *
 * Local rather than a `readBooleanField` beside `readStringField`: this is the
 * only boolean any endpoint in the application takes, and a shared helper for
 * one caller is a file to find rather than a line to read.
 *
 * Anything that is not literally `true` means "no repeats". The safe reading of
 * a malformed body is the one that cannot call a number twice.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 */
const readAllowRepeats = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;

  return (body as Record<string, unknown>).allowRepeats === true;
};

/** The standing draws and the counters, for the page's first paint. */
export const draws: RequestHandler = async (req, res, next) => {
  try {
    const service = new RaffleService({ req, res });

    // The whole point of this endpoint is to be current; a cached copy would
    // show an operator numbers that have already been called.
    res.setHeader('Cache-Control', 'no-store');

    res.json({
      success: true,
      code: 'RAFFLE_DRAWS',
      data: await service.view(),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Calls one number.
 *
 * An exhausted pool arrives as a `ConflictError` and therefore a 409 — the
 * request was well formed and the operator is permitted; there is simply
 * nothing left. The page has copy for exactly that.
 */
export const draw: RequestHandler = async (req, res, next) => {
  try {
    const service = new RaffleService({ req, res });

    res.json({
      success: true,
      code: 'RAFFLE_DRAWN',
      data: await service.draw(readAllowRepeats(req.body)),
    });
  } catch (err) {
    next(err);
  }
};

/** Puts a drawn number back into the pool. */
export const reset: RequestHandler = async (req, res, next) => {
  try {
    const drawId = readStringField(req.body, 'drawId');

    if (!drawId) throw new ValidationError('Invalid draw');

    const service = new RaffleService({ req, res });

    res.json({
      success: true,
      code: 'RAFFLE_RESET',
      data: await service.reset(drawId),
    });
  } catch (err) {
    next(err);
  }
};
