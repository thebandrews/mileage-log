import { z } from 'zod';
import { CLASSIFICATIONS, TRIP_SOURCES, VEHICLE_KINDS } from './types.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const odometer = z.number().nonnegative().max(2_000_000).nullish().transform((v) => v ?? null);

/** Round to one decimal place without floating-point drift. */
export function roundMiles(value: number): number {
  return Math.round(value * 10) / 10;
}

export const tripInputSchema = z
  .object({
    vehicleId: z.uuid().nullish().transform((v) => v ?? null),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso
      .datetime({ offset: true })
      .nullish()
      .transform((v) => v ?? null),
    startLabel: optionalText(200),
    endLabel: optionalText(200),
    startOdometer: odometer,
    endOdometer: odometer,
    miles: z.number().positive().max(5000).nullish().transform((v) => v ?? null),
    classification: z.enum(CLASSIFICATIONS).default('unclassified'),
    purpose: optionalText(500),
    client: optionalText(200),
    notes: optionalText(2000),
    source: z.enum(TRIP_SOURCES).default('manual'),
  })
  .superRefine((t, ctx) => {
    const hasStart = t.startOdometer !== null;
    const hasEnd = t.endOdometer !== null;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: 'custom',
        path: [hasStart ? 'endOdometer' : 'startOdometer'],
        message: 'Enter both odometer readings, or neither.',
      });
    }
    if (hasStart && hasEnd && t.endOdometer! <= t.startOdometer!) {
      ctx.addIssue({
        code: 'custom',
        path: ['endOdometer'],
        message: 'End odometer must be greater than start odometer.',
      });
    }
    if (!(hasStart && hasEnd) && t.miles === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['miles'],
        message: 'Enter the miles driven or both odometer readings.',
      });
    }
    if (t.endedAt && Date.parse(t.endedAt) < Date.parse(t.startedAt)) {
      ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'Trip cannot end before it starts.' });
    }
    if (t.classification === 'business') {
      if (!t.endLabel) {
        ctx.addIssue({ code: 'custom', path: ['endLabel'], message: 'Business trips need a destination.' });
      }
      if (!t.purpose) {
        ctx.addIssue({ code: 'custom', path: ['purpose'], message: 'Business trips need a business purpose.' });
      }
    }
  })
  .transform((t) => {
    const fromOdometer =
      t.startOdometer !== null && t.endOdometer !== null ? t.endOdometer - t.startOdometer : null;
    return { ...t, miles: roundMiles(fromOdometer ?? t.miles!) };
  });

export type TripInput = z.input<typeof tripInputSchema>;
export type NormalizedTripInput = z.output<typeof tripInputSchema>;

export const vehicleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(VEHICLE_KINDS).default('car'),
  isTesla: z.boolean().default(false),
  qualifiedNonpersonalUse: z.boolean().default(false),
  archived: z.boolean().default(false),
});
export type VehicleInput = z.input<typeof vehicleInputSchema>;

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const point = z
  .object({ latitude, longitude })
  .nullish()
  .transform((v) => v ?? null);

/** Start a trip: what's known when you tap Start. */
export const tripStartSchema = z.object({
  vehicleId: z.uuid().nullish().transform((v) => v ?? null),
  startedAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .transform((v) => v ?? null),
  location: point,
  /** Manual reading when the car can't be read automatically. */
  startOdometer: odometer,
});
export type TripStartInput = z.input<typeof tripStartSchema>;

/** End a trip: miles come from the car, the odometer, or the phone's GPS distance. */
export const tripEndSchema = z.object({
  endedAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .transform((v) => v ?? null),
  location: point,
  endOdometer: odometer,
  /** Distance the phone measured, when there's no odometer. */
  gpsMiles: z.number().positive().max(5000).nullish().transform((v) => v ?? null),
  /** Miles typed in, when the trip has no start odometer and the phone didn't measure it. */
  miles: z.number().positive().max(5000).nullish().transform((v) => v ?? null),
});
export type TripEndInput = z.input<typeof tripEndSchema>;

/** One-tap classification from the trip inbox. */
export const classifySchema = z.object({
  classification: z.enum(['business', 'personal', 'commute']),
});
export type ClassifyInput = z.input<typeof classifySchema>;

export const settingsInputSchema = z.object({
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone.')
    .optional(),
  customRateCents: z.number().positive().max(500).nullable().optional(),
});
export type SettingsInput = z.input<typeof settingsInputSchema>;

/** A date range in local dates, inclusive: from=2026-11-01, to=2026-11-30. */
export const dateRangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((r) => r.from <= r.to, { message: '"from" must be on or before "to".', path: ['to'] });

/** Flatten zod issues into { field: message } for forms and API errors. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
