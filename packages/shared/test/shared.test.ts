import { describe, expect, it } from 'vitest';
import {
  fieldErrors,
  irsBusinessRateCents,
  localDate,
  summarizeTrips,
  tripInputSchema,
  tripsToCsv,
  utcBoundsForLocalRange,
  type Trip,
  type Vehicle,
} from '../src/index.js';

const TZ = 'America/Los_Angeles';

function trip(overrides: Partial<Trip>): Trip {
  return {
    id: crypto.randomUUID(),
    vehicleId: null,
    startedAt: '2026-11-03T16:00:00Z',
    endedAt: null,
    startLabel: 'Yard',
    endLabel: 'Sky Nursery',
    startOdometer: null,
    endOdometer: null,
    miles: 10,
    status: 'finished',
    startLat: null,
    startLng: null,
    endLat: null,
    endLng: null,
    classification: 'business',
    purpose: 'Materials pickup',
    client: null,
    notes: null,
    source: 'manual',
    createdAt: '2026-11-03T16:00:00Z',
    updatedAt: '2026-11-03T16:00:00Z',
    ...overrides,
  };
}

describe('tripInputSchema', () => {
  const base = {
    startedAt: '2026-11-03T08:00:00-08:00',
    classification: 'business',
    endLabel: 'Smith residence',
    purpose: 'Site walk',
  } as const;

  it('computes miles from odometer readings', () => {
    const r = tripInputSchema.parse({ ...base, startOdometer: 12000.2, endOdometer: 12012.6 });
    expect(r.miles).toBe(12.4);
  });

  it('accepts miles without odometer readings', () => {
    expect(tripInputSchema.parse({ ...base, miles: 7.25 }).miles).toBe(7.3);
  });

  it('requires miles or both odometer readings', () => {
    const r = tripInputSchema.safeParse({ ...base });
    expect(r.success).toBe(false);
    expect(fieldErrors(r.error!)).toHaveProperty('miles');
  });

  it('rejects a single odometer reading and a backwards odometer', () => {
    expect(fieldErrors(tripInputSchema.safeParse({ ...base, startOdometer: 5 }).error!)).toHaveProperty(
      'endOdometer',
    );
    const backwards = tripInputSchema.safeParse({ ...base, startOdometer: 10, endOdometer: 9 });
    expect(fieldErrors(backwards.error!).endOdometer).toMatch(/greater/);
  });

  it('requires destination and purpose for business trips only', () => {
    const r = tripInputSchema.safeParse({ startedAt: base.startedAt, miles: 3, classification: 'business' });
    expect(Object.keys(fieldErrors(r.error!)).sort()).toEqual(['endLabel', 'purpose']);
    expect(
      tripInputSchema.safeParse({ startedAt: base.startedAt, miles: 3, classification: 'personal' }).success,
    ).toBe(true);
  });

  it('defaults to unclassified manual trips and trims empty text to null', () => {
    const r = tripInputSchema.parse({ startedAt: base.startedAt, miles: 1, notes: '   ' });
    expect(r.classification).toBe('unclassified');
    expect(r.source).toBe('manual');
    expect(r.notes).toBeNull();
  });
});

describe('rates', () => {
  it('handles the 2026 mid-year IRS rate change', () => {
    expect(irsBusinessRateCents('2025-12-31')).toBe(70);
    expect(irsBusinessRateCents('2026-06-30')).toBe(72.5);
    expect(irsBusinessRateCents('2026-07-01')).toBe(76);
    expect(irsBusinessRateCents('2019-01-01')).toBeNull();
  });
});

describe('dates', () => {
  it('buckets by local date, not UTC date', () => {
    // 11pm Pacific on Nov 3 is Nov 4 in UTC.
    expect(localDate('2026-11-04T07:00:00Z', TZ)).toBe('2026-11-03');
  });

  it('finds UTC bounds across a DST change', () => {
    // DST ends Nov 1, 2026 in the US.
    const [start, end] = utcBoundsForLocalRange('2026-10-01', '2026-11-30', TZ);
    expect(start.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });
});

describe('summarizeTrips', () => {
  it('totals by classification, day and month with exact tenths', () => {
    const trips = [
      trip({ miles: 0.1 }),
      trip({ miles: 0.2 }),
      trip({ miles: 5, classification: 'personal', startedAt: '2026-11-04T18:00:00Z' }),
      trip({ miles: 2.5, classification: 'unclassified', endLabel: null, purpose: null }),
    ];
    const s = summarizeTrips(trips, { from: '2026-11-01', to: '2026-11-30', timezone: TZ });
    expect(s.totals.business).toBe(0.3);
    expect(s.totals.personal).toBe(5);
    expect(s.totals.unclassified).toBe(2.5);
    expect(s.totals.total).toBe(7.8);
    expect(s.totals.trips).toBe(4);
    expect(s.byDay.map((d) => d.period)).toEqual(['2026-11-03', '2026-11-04']);
    expect(s.byMonth).toHaveLength(1);
    // 0.3 mi × 76¢ = 22.8¢ → 23¢
    expect(s.totals.businessValueCents).toBe(23);
  });

  it('values business miles at the rate in force on each trip date', () => {
    const trips = [
      trip({ miles: 100, startedAt: '2026-06-30T18:00:00Z' }),
      trip({ miles: 100, startedAt: '2026-07-01T18:00:00Z' }),
    ];
    const s = summarizeTrips(trips, { from: '2026-01-01', to: '2026-12-31', timezone: TZ });
    expect(s.totals.businessValueCents).toBe(7250 + 7600);
    expect(s.byMonth.map((m) => m.businessValueCents)).toEqual([7250, 7600]);
  });

  it('uses a custom rate when set and skips trips outside the range', () => {
    const trips = [trip({ miles: 10 }), trip({ miles: 10, startedAt: '2026-12-01T18:00:00Z' })];
    const s = summarizeTrips(trips, { from: '2026-11-01', to: '2026-11-30', timezone: TZ, customRateCents: 50 });
    expect(s.totals.trips).toBe(1);
    expect(s.totals.businessValueCents).toBe(500);
  });

  it('ignores trips still in progress', () => {
    const s = summarizeTrips([trip({ miles: 0, status: 'in_progress', purpose: null }), trip({ miles: 4 })], {
      from: '2026-11-01',
      to: '2026-11-30',
      timezone: TZ,
    });
    expect(s.totals.trips).toBe(1);
    expect(s.incompleteBusinessTrips).toBe(0);
  });

  it('counts business trips missing destination or purpose', () => {
    const s = summarizeTrips([trip({ purpose: null }), trip({})], {
      from: '2026-11-01',
      to: '2026-11-30',
      timezone: TZ,
    });
    expect(s.incompleteBusinessTrips).toBe(1);
  });
});

describe('tripsToCsv', () => {
  it('writes a header and escapes quotes, commas and formulas', () => {
    const vehicles: Vehicle[] = [
      {
        id: 'v1',
        name: 'Model Y',
        kind: 'car',
        isTesla: true,
        qualifiedNonpersonalUse: false,
        archived: false,
        teslaVin: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const csv = tripsToCsv(
      [trip({ vehicleId: 'v1', purpose: 'Bid, "rush"', notes: '=HYPERLINK("x")', startOdometer: 1, endOdometer: 11 })],
      vehicles,
      TZ,
    );
    const [header, row] = csv.trimEnd().split('\r\n');
    expect(header.startsWith('Date,Start time,End time,Vehicle')).toBe(true);
    expect(row).toContain('2026-11-03,08:00,,Model Y,1.0,11.0,10.0,business,Yard,Sky Nursery');
    expect(row).toContain('"Bid, ""rush"""');
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
