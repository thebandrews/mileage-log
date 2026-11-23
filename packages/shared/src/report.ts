import { irsBusinessRateCents } from './rates.js';
import type {
  Classification,
  ClassificationTotals,
  PeriodSummary,
  ReportSummary,
  Trip,
  Vehicle,
} from './types.js';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date (YYYY-MM-DD) of an ISO timestamp in a time zone. */
export function localDate(iso: string, timezone: string): string {
  let fmt = dateFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timezone, fmt);
  }
  return fmt.format(new Date(iso));
}

/** Local 24-hour time (HH:MM) of an ISO timestamp in a time zone. */
export function localTime(iso: string, timezone: string): string {
  let fmt = timeFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    timeFormatters.set(timezone, fmt);
  }
  return fmt.format(new Date(iso));
}

/**
 * The UTC instants bounding a local-date range [from, to] in a time zone,
 * as [startInclusive, endExclusive]. Handles DST by asking Intl for the offset.
 */
export function utcBoundsForLocalRange(from: string, to: string, timezone: string): [Date, Date] {
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return [localMidnightUtc(from, timezone), localMidnightUtc(next.toISOString().slice(0, 10), timezone)];
}

function localMidnightUtc(date: string, timezone: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  // Offset of the zone at the guess, then correct once more for DST edges.
  let utc = guess.getTime() - offsetMs(guess, timezone);
  utc = guess.getTime() - offsetMs(new Date(utc), timezone);
  return new Date(utc);
}

function offsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Miles are summed in tenths so totals never show float noise like 12.299999. */
const toTenths = (miles: number) => Math.round(miles * 10);
const fromTenths = (tenths: number) => tenths / 10;

interface Bucket {
  tenths: Record<Classification, number>;
  trips: number;
  businessValueTenthCents: number;
}

const emptyBucket = (): Bucket => ({
  tenths: { business: 0, personal: 0, commute: 0, unclassified: 0 },
  trips: 0,
  businessValueTenthCents: 0,
});

function toTotals(b: Bucket): ClassificationTotals {
  const t = b.tenths;
  return {
    business: fromTenths(t.business),
    personal: fromTenths(t.personal),
    commute: fromTenths(t.commute),
    unclassified: fromTenths(t.unclassified),
    total: fromTenths(t.business + t.personal + t.commute + t.unclassified),
  };
}

export function isBusinessTripComplete(trip: Trip): boolean {
  return trip.classification !== 'business' || Boolean(trip.endLabel && trip.purpose);
}

export interface SummaryOptions {
  from: string;
  to: string;
  timezone: string;
  /** Overrides the IRS rate when set (e.g. an employer reimbursement rate). */
  customRateCents?: number | null;
}

/** Totals by classification, per day and per month, plus business value at the IRS rate. */
export function summarizeTrips(trips: readonly Trip[], opts: SummaryOptions): ReportSummary {
  const overall = emptyBucket();
  const days = new Map<string, Bucket>();
  const months = new Map<string, Bucket>();
  let incomplete = 0;

  for (const trip of trips) {
    const day = localDate(trip.startedAt, opts.timezone);
    if (day < opts.from || day > opts.to) continue;
    const month = day.slice(0, 7);
    const tenths = toTenths(trip.miles);
    const rate = opts.customRateCents ?? irsBusinessRateCents(day) ?? 0;
    const valueTenthCents = trip.classification === 'business' ? tenths * rate : 0;
    if (!isBusinessTripComplete(trip)) incomplete++;

    for (const bucket of [
      overall,
      getOrCreate(days, day),
      getOrCreate(months, month),
    ]) {
      bucket.tenths[trip.classification] += tenths;
      bucket.trips++;
      bucket.businessValueTenthCents += valueTenthCents;
    }
  }

  const toPeriods = (map: Map<string, Bucket>): PeriodSummary[] =>
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, b]) => ({
        period,
        ...toTotals(b),
        trips: b.trips,
        businessValueCents: Math.round(b.businessValueTenthCents / 10),
      }));

  return {
    from: opts.from,
    to: opts.to,
    timezone: opts.timezone,
    totals: {
      ...toTotals(overall),
      trips: overall.trips,
      businessValueCents: Math.round(overall.businessValueTenthCents / 10),
    },
    incompleteBusinessTrips: incomplete,
    byDay: toPeriods(days),
    byMonth: toPeriods(months),
  };
}

function getOrCreate(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = emptyBucket();
    map.set(key, b);
  }
  return b;
}

export const LOG_COLUMNS = [
  'Date',
  'Start time',
  'End time',
  'Vehicle',
  'Start odometer',
  'End odometer',
  'Miles',
  'Classification',
  'From',
  'Destination',
  'Business purpose',
  'Client',
  'Notes',
  'Source',
] as const;

/** One row per trip, in the column order of LOG_COLUMNS. */
export function logRows(
  trips: readonly Trip[],
  vehicles: readonly Vehicle[],
  timezone: string,
): string[][] {
  const names = new Map(vehicles.map((v) => [v.id, v.name]));
  return [...trips]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((t) => [
      localDate(t.startedAt, timezone),
      localTime(t.startedAt, timezone),
      t.endedAt ? localTime(t.endedAt, timezone) : '',
      t.vehicleId ? (names.get(t.vehicleId) ?? '') : '',
      t.startOdometer?.toFixed(1) ?? '',
      t.endOdometer?.toFixed(1) ?? '',
      t.miles.toFixed(1),
      t.classification,
      t.startLabel ?? '',
      t.endLabel ?? '',
      t.purpose ?? '',
      t.client ?? '',
      t.notes ?? '',
      t.source,
    ]);
}

function csvCell(value: string): string {
  // Guard against spreadsheet formula injection, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV of the mileage log, with a header row. */
export function tripsToCsv(trips: readonly Trip[], vehicles: readonly Vehicle[], timezone: string): string {
  const lines = [LOG_COLUMNS as readonly string[], ...logRows(trips, vehicles, timezone)];
  return lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
