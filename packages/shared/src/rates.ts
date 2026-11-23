/**
 * IRS optional standard mileage rates for business use, in cents per mile.
 * 2026 changed mid-year: 72.5¢ for Jan 1–Jun 30 (IR-2025-128, Notice 2026-10)
 * and 76¢ from Jul 1 (IR-2026-29). Add a new period each time the IRS
 * announces a rate. Periods are inclusive and must not overlap.
 */
export interface RatePeriod {
  from: string; // YYYY-MM-DD
  to: string | null; // YYYY-MM-DD, null = open-ended
  cents: number;
  source: string;
}

export const IRS_BUSINESS_RATES: readonly RatePeriod[] = [
  { from: '2024-01-01', to: '2024-12-31', cents: 67, source: 'IR-2023-239' },
  { from: '2025-01-01', to: '2025-12-31', cents: 70, source: 'IR-2024-312' },
  { from: '2026-01-01', to: '2026-06-30', cents: 72.5, source: 'IR-2025-128' },
  { from: '2026-07-01', to: null, cents: 76, source: 'IR-2026-29' },
];

/** Business rate in cents per mile for a local date (YYYY-MM-DD). */
export function irsBusinessRateCents(date: string): number | null {
  for (const period of IRS_BUSINESS_RATES) {
    if (date >= period.from && (period.to === null || date <= period.to)) {
      return period.cents;
    }
  }
  return null;
}
