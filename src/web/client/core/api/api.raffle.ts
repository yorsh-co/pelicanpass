import { request } from './api.request.ts';

/** One number that has been called and not put back. */
export interface RaffleDraw {
  drawId: string;
  checkinNumber: number;
  drawnAt: string;
}

/** Everything the raffle page renders from. */
export interface RaffleView {
  draws: RaffleDraw[];
  poolSize: number;
  remaining: number;
  poolMin: number;
  poolMax: number;
}

/** The result of one draw: the number called, and the view it left behind. */
export interface RaffleDrawResult extends RaffleView {
  draw: RaffleDraw;
}

/**
 * The response envelope, with everything optional.
 *
 * The other API modules do the same: what crosses the wire is a claim about
 * shape, not a guarantee of one, and narrowing here is cheaper than a surprise
 * on a stage.
 */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Narrows a view off the wire, or throws.
 *
 * The counters are checked as numbers rather than defaulted to zero: a missing
 * `remaining` rendered as "0 restantes" would tell an operator the draw is over
 * when it is not.
 *
 * @param data - The envelope's payload.
 * @param what - Which call is being narrowed, for the thrown message.
 */
const toView = (
  data: Partial<RaffleView> | undefined,
  what: string,
): RaffleView => {
  if (
    typeof data?.poolSize !== 'number' ||
    typeof data.remaining !== 'number' ||
    typeof data.poolMin !== 'number' ||
    typeof data.poolMax !== 'number'
  ) {
    throw new Error(`${what} returned no view`);
  }

  return {
    draws: data.draws ?? [],
    poolSize: data.poolSize,
    remaining: data.remaining,
    poolMin: data.poolMin,
    poolMax: data.poolMax,
  };
};

/** The standing draws and the counters. */
export const getDraws = async (): Promise<RaffleView> => {
  const res = await request<Envelope<RaffleView>>('/api/v1/raffle/draws');

  return toView(res.data, 'Draws');
};

/**
 * Calls one number.
 *
 * An exhausted pool arrives as a 409, which the caller branches on — it is an
 * answer about the raffle rather than a failure of the request, but it is the
 * one answer that has to stop the animation before it starts.
 *
 * @param allowRepeats - Whether numbers already standing may be called again.
 * @param idempotencyKey - The same for every attempt at one draw, so a re-tap
 *   after a timeout shows the number already called rather than calling
 *   another.
 */
export const draw = async (
  allowRepeats: boolean,
  idempotencyKey: string,
): Promise<RaffleDrawResult> => {
  const res = await request<Envelope<RaffleDrawResult>>('/api/v1/raffle/draw', {
    method: 'POST',
    json: { allowRepeats },
    headers: { 'Idempotency-Key': idempotencyKey },
  });

  const drawn = res.data?.draw;

  if (!drawn?.drawId || typeof drawn.checkinNumber !== 'number') {
    throw new Error('Draw returned no number');
  }

  return { draw: drawn, ...toView(res.data, 'Draw') };
};

/**
 * Puts a drawn number back into the pool.
 *
 * @param drawId - The draw to clear.
 */
export const reset = async (drawId: string): Promise<RaffleView> => {
  const res = await request<Envelope<RaffleView>>('/api/v1/raffle/reset', {
    method: 'POST',
    json: { drawId },
  });

  return toView(res.data, 'Reset');
};
