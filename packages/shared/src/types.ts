export const CLASSIFICATIONS = ['business', 'personal', 'commute', 'unclassified'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const TRIP_SOURCES = ['manual', 'tesla', 'gps'] as const;
export type TripSource = (typeof TRIP_SOURCES)[number];

export const TRIP_STATUSES = ['in_progress', 'finished'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const VEHICLE_KINDS = ['car', 'truck', 'van', 'other'] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

export interface Trip {
  id: string;
  vehicleId: string | null;
  /** ISO 8601 timestamp with offset. */
  startedAt: string;
  endedAt: string | null;
  /** Where the trip started, as the user or a geocoder named it. */
  startLabel: string | null;
  /** Destination — required by the IRS for business trips. */
  endLabel: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
  /** Miles, one decimal place. 0 while the trip is in progress. */
  miles: number;
  /** A started trip is in progress until it's ended. Reports only count finished trips. */
  status: TripStatus;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  classification: Classification;
  /** Business purpose — required by the IRS for business trips. */
  purpose: string | null;
  client: string | null;
  notes: string | null;
  source: TripSource;
  createdAt: string;
  updatedAt: string;
}

export interface Vehicle {
  id: string;
  name: string;
  kind: VehicleKind;
  isTesla: boolean;
  /**
   * Marked, modified work trucks and heavy cargo vehicles are qualified
   * nonpersonal use vehicles and don't need per-trip substantiation.
   */
  qualifiedNonpersonalUse: boolean;
  archived: boolean;
  /** Set once the vehicle is linked to a Tesla account. */
  teslaVin: string | null;
  createdAt: string;
}

export interface Settings {
  /** IANA time zone used to bucket trips into days and months. */
  timezone: string;
  /** Optional override of the IRS business rate, in cents per mile. */
  customRateCents: number | null;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
}

export interface ClassificationTotals {
  business: number;
  personal: number;
  commute: number;
  unclassified: number;
  total: number;
}

export interface PeriodSummary extends ClassificationTotals {
  /** YYYY-MM-DD for days, YYYY-MM for months. */
  period: string;
  trips: number;
  businessValueCents: number;
}

export interface ReportSummary {
  from: string;
  to: string;
  timezone: string;
  totals: ClassificationTotals & { trips: number; businessValueCents: number };
  /** Business trips missing a destination or purpose — not IRS-ready yet. */
  incompleteBusinessTrips: number;
  byDay: PeriodSummary[];
  byMonth: PeriodSummary[];
}

/** Where the app should get the miles for a started trip. */
export type MilesSource = 'tesla' | 'odometer' | 'gps';

export interface TeslaStatus {
  /** The Tesla developer app is set up on the server. */
  configured: boolean;
  /** This user has linked a Tesla account. */
  connected: boolean;
}
