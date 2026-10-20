import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fitsBudget,
  fromMicros,
  priceMicros,
  resolveDoorAvailability,
  resolveReservation,
  spentMicros,
  toMicros,
} from './whatsapp.budget.ts';
import { TEMPLATE_PRICE_USD } from '../../constants/whatsapp-templates.ts';

import type {
  DoorAvailabilityInput,
  ReservationInput,
} from './whatsapp.budget.ts';

const UTILITY = toMicros(TEMPLATE_PRICE_USD.utility);
const MARKETING = toMicros(TEMPLATE_PRICE_USD.marketing);

describe('toMicros', () => {
  it('converts four-decimal rates exactly', () => {
    assert.equal(toMicros(0.0068), 6_800);
    assert.equal(toMicros(0.0625), 62_500);
    assert.equal(fromMicros(6_800), 0.0068);
  });

  it('does not drift where a float sum would', () => {
    let float = 0;

    for (let i = 0; i < 1_000; i += 1) float += 0.0068;

    assert.notEqual(float, 6.8);
    assert.equal(
      spentMicros([{ templateKey: 'pax_door_v1:pt_BR', count: 1_000 }]),
      toMicros(6.8),
    );
  });
});

describe('priceMicros', () => {
  it('prices a registry template by its category', () => {
    assert.equal(priceMicros('pax_door_v1:pt_BR'), UTILITY);
  });

  it('prices an unknown key at the dearest rate', () => {
    assert.equal(priceMicros('retired_template:pt_BR'), MARKETING);
  });
});

describe('spentMicros', () => {
  it('sums every template at its own price', () => {
    assert.equal(
      spentMicros([
        { templateKey: 'pax_wk_v1:pt_BR', count: 700 },
        { templateKey: 'pax_door_v1:pt_BR', count: 30 },
        { templateKey: 'retired_template:pt_BR', count: 2 },
      ]),
      730 * UTILITY + 2 * MARKETING,
    );
  });

  it('is zero with nothing sent', () => {
    assert.equal(spentMicros([]), 0);
  });
});

describe('fitsBudget', () => {
  it('allows a message that lands exactly on the budget', () => {
    assert.equal(fitsBudget(toMicros(0.9932), UTILITY, toMicros(1)), true);
  });

  it('allows one under the budget', () => {
    assert.equal(fitsBudget(toMicros(0.99), UTILITY, toMicros(1)), true);
  });

  it('refuses one that would pass it by a micro-dollar', () => {
    assert.equal(fitsBudget(toMicros(0.9932) + 1, UTILITY, toMicros(1)), false);
  });

  it('refuses everything under a zero budget', () => {
    assert.equal(fitsBudget(0, UTILITY, 0), false);
  });
});

describe('resolveDoorAvailability', () => {
  const open: DoorAvailabilityInput = {
    unlocked: true,
    switchOn: true,
    spent: 0,
    price: UTILITY,
    budget: toMicros(10),
  };

  it('is available when unlocked, switched on and under budget', () => {
    assert.deepEqual(resolveDoorAvailability(open), { available: true });
  });

  it('reports the env lock before anything else', () => {
    assert.deepEqual(
      resolveDoorAvailability({
        ...open,
        unlocked: false,
        switchOn: false,
        spent: toMicros(100),
      }),
      { available: false, reason: 'lockedByEnv' },
    );
  });

  it('reports the switch before the budget', () => {
    assert.deepEqual(
      resolveDoorAvailability({
        ...open,
        switchOn: false,
        spent: toMicros(100),
      }),
      { available: false, reason: 'switchedOff' },
    );
  });

  it('reports the budget last', () => {
    assert.deepEqual(
      resolveDoorAvailability({ ...open, spent: toMicros(10) }),
      { available: false, reason: 'overBudget' },
    );
  });
});

describe('resolveReservation', () => {
  const clear: ReservationInput = {
    numberTaken: false,
    attendeeSends: 0,
    cap: 3,
    spent: 0,
    price: UTILITY,
    budget: toMicros(10),
  };

  it('reserves a fresh number for an attendee under the cap', () => {
    assert.equal(resolveReservation(clear), 'ok');
  });

  it('reports a taken number before the cap and the budget', () => {
    assert.equal(
      resolveReservation({
        ...clear,
        numberTaken: true,
        attendeeSends: 3,
        spent: toMicros(10),
      }),
      'alreadySent',
    );
  });

  it('reports the cap before the budget', () => {
    assert.equal(
      resolveReservation({ ...clear, attendeeSends: 3, spent: toMicros(10) }),
      'attendeeCapReached',
    );
  });

  it('allows the last message under the cap', () => {
    assert.equal(resolveReservation({ ...clear, attendeeSends: 2 }), 'ok');
  });

  it('reports the budget last', () => {
    assert.equal(
      resolveReservation({ ...clear, spent: toMicros(10) - UTILITY + 1 }),
      'overBudget',
    );
  });

  it('allows a message that lands exactly on the budget', () => {
    assert.equal(
      resolveReservation({ ...clear, spent: toMicros(10) - UTILITY }),
      'ok',
    );
  });
});
