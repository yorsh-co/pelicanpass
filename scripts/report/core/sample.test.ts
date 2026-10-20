import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_FILTERS, STAFF_CHURCH } from './filter.ts';
import { describe, it } from 'node:test';

import { UNKNOWN_AGE } from './age.ts';
import { parseCheckin } from './checkin.ts';
import {
  byAgeDetail,
  byArea,
  byChurch,
  ticketSummary,
  volunteerSummary,
} from './metrics.ts';
import { generateSampleCsv } from './sample.ts';
import { salesEventDate } from './sales.ts';
import { parseSurveyCsv } from './survey.ts';

import type { Definitions } from './model.ts';

const definitions: Definitions = {
  participant: [
    { id: 'programme_rating', label: 'Programação', type: 'rating' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
    { id: 'would_return', label: 'Voltaria', type: 'yes-no' },
    { id: 'low_rating_reason', label: 'Por quê', type: 'text' },
    { id: 'comments', label: 'Comentários', type: 'text' },
  ],
  volunteer: [
    { id: 'volunteer_area', label: 'Área', type: 'text' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
  ],
};

describe('generateSampleCsv', () => {
  const sample = generateSampleCsv(definitions);

  it('includes the host church and no participant t-shirt redemptions', () => {
    const participants = parseCheckin(sample.checkin).filter(
      (a) => a.role === 'participant',
    );

    assert.ok(participants.some((a) => a.church === 'Igreja Exemplo A'));
    assert.ok(participants.some((a) => a.church === STAFF_CHURCH));
    assert.ok(participants.some((a) => a.items.tshirt.option !== null));
    assert.ok(participants.every((a) => a.items.tshirt.redeemedAt === null));
  });

  it('leaves the staff out under the default filters, and keeps volunteers', () => {
    const attendees = parseCheckin(sample.checkin);
    const rows = applyFilters(attendees, {
      ...DEFAULT_FILTERS,
      audience: 'all',
    });

    assert.ok(rows.length < attendees.length);
    assert.ok(rows.every((a) => a.church !== STAFF_CHURCH));
    assert.equal(
      rows.filter((a) => a.role === 'volunteer').length,
      attendees.filter((a) => a.role === 'volunteer').length,
    );
  });

  it('has age bands for most participants and no exact ages', () => {
    const attendees = parseCheckin(sample.checkin);
    const participants = attendees.filter((a) => a.role === 'participant');
    const rows = byAgeDetail(attendees);

    assert.ok(participants.some((a) => a.ageDetail === null));
    assert.ok(participants.filter((a) => a.ageDetail !== null).length > 500);
    assert.equal(rows.length, 9);
    assert.equal(rows.at(-1)?.detail, UNKNOWN_AGE);
    assert.ok(!JSON.stringify(attendees).toLowerCase().includes('"age"'));
  });

  it('is deterministic for a seed and varies across seeds', () => {
    assert.deepEqual(generateSampleCsv(definitions), sample);
    assert.notEqual(generateSampleCsv(definitions, 7).checkin, sample.checkin);
  });

  it('produces a check-in export the real parser reads', () => {
    const attendees = parseCheckin(sample.checkin);
    const tickets = ticketSummary(attendees);

    assert.equal(tickets.tickets, 644);
    assert.equal(tickets.archived, 6);
    assert.ok(tickets.walkIns !== null && tickets.walkIns > 30);
    assert.ok((tickets.noShowRate ?? 0) > 0.08);
    assert.equal(volunteerSummary(attendees).total, 90);
    assert.equal(byChurch(attendees).length, 8);
  });

  it('keeps arrivals inside the stated evening and afternoon windows', () => {
    const hour = (ms: number | null): number =>
      new Date((ms ?? 0) - 3 * 3_600_000).getUTCHours() +
      new Date((ms ?? 0) - 3 * 3_600_000).getUTCMinutes() / 60;

    for (const a of parseCheckin(sample.checkin)) {
      if (a.checkinAt === null) continue;
      const [from, to] = a.role === 'participant' ? [19, 20.5] : [15, 17.5];

      assert.ok(hour(a.checkinAt) >= from && hour(a.checkinAt) <= to);
    }
  });

  it('has volunteers eat lunch after they check in', () => {
    for (const a of parseCheckin(sample.checkin)) {
      const lunch = a.items.lunch.redeemedAt;

      if (a.role === 'volunteer' && lunch !== null) {
        assert.ok(a.checkinAt !== null && lunch >= a.checkinAt);
      }
    }
  });

  it('produces surveys with the real question ids', () => {
    const participant = parseSurveyCsv(
      sample.participant,
      definitions.participant,
    );
    const volunteer = parseSurveyCsv(
      sample.volunteer ?? '',
      definitions.volunteer ?? [],
    );

    assert.equal(participant.responses.length, 200);
    assert.equal(volunteer.responses.length, 45);
    assert.deepEqual(
      participant.questions.map((q) => q.id),
      definitions.participant.map((q) => q.id),
    );
    assert.ok(byArea(volunteer).areas.length > 0);
  });

  it('omits the volunteer survey without a definition', () => {
    assert.equal(
      generateSampleCsv({ ...definitions, volunteer: null }).volunteer,
      null,
    );
  });

  it('dates participant sales, with walk-ins on the event day', () => {
    const rows = parseCheckin(sample.checkin);
    const csv = sample.checkin.split('\r\n');
    const participants = rows.filter((a) => a.role === 'participant');
    const dated = participants.flatMap((a) =>
      a.saleDate === null ? [] : [a.saleDate],
    );
    const walkIns = participants.filter((a) => a.walkIn);

    assert.ok(dated.length > 600);
    assert.ok(participants.length - dated.length > 0);
    assert.ok(participants.length - dated.length < 40);
    assert.ok(dated.every((d) => d <= '2026-10-17' && d >= '2026-02-01'));
    assert.ok(walkIns.length > 0);
    assert.ok(
      walkIns.every((a) => a.saleDate === null || a.saleDate === '2026-10-17'),
    );
    assert.ok(
      rows
        .filter((a) => a.role === 'volunteer')
        .every((a) => a.saleDate === null),
    );
    assert.ok(csv.some((line) => /\d{2}\/\d{2}\/\d{4}/.test(line)));
    assert.ok(csv.some((line) => /\d{4}-\d{2}-\d{2} \d{2}:30:00/.test(line)));
  });

  it('lines the event day up with the first check-in', () => {
    assert.equal(salesEventDate(parseCheckin(sample.checkin)), '2026-10-17');
  });
});
