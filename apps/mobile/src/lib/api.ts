import type {
  ReportSummary,
  Settings,
  TeslaStatus,
  ClassifyInput,
  Trip,
  TripEndInput,
  TripInput,
  TripStartInput,
  User,
  Vehicle,
  VehicleInput,
} from '@mileage/shared';
import { useMemo } from 'react';
import { useAuth } from './auth';
import { config } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export type Me = User & Settings;

export interface Range {
  from: string;
  to: string;
}

const qs = (r: Range) => `from=${r.from}&to=${r.to}`;

export function useApi() {
  const { getAccessToken } = useAuth();

  return useMemo(() => {
    async function headers(): Promise<Record<string, string>> {
      const h: Record<string, string> = { 'content-type': 'application/json' };
      if (config.authMode === 'dev') {
        h['x-dev-user'] = config.devUser;
      } else {
        h.authorization = `Bearer ${await getAccessToken()}`;
      }
      return h;
    }

    async function raw(method: string, path: string, body?: unknown): Promise<Response> {
      const res = await fetch(`${config.apiUrl}${path}`, {
        method,
        headers: await headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
        throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.fields);
      }
      return res;
    }

    async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await raw(method, path, body);
      return (res.status === 204 ? undefined : await res.json()) as T;
    }

    return {
      me: () => json<Me>('GET', '/me'),
      updateSettings: (s: Partial<Settings>) => json<Me>('PUT', '/settings', s),
      vehicles: () => json<Vehicle[]>('GET', '/vehicles'),
      createVehicle: (v: VehicleInput) => json<Vehicle>('POST', '/vehicles', v),
      updateVehicle: (id: string, v: VehicleInput) => json<Vehicle>('PUT', `/vehicles/${id}`, v),
      trips: (r: Range) => json<Trip[]>('GET', `/trips?${qs(r)}`),
      trip: (id: string) => json<Trip>('GET', `/trips/${id}`),
      createTrip: (t: TripInput) => json<Trip>('POST', '/trips', t),
      updateTrip: (id: string, t: TripInput) => json<Trip>('PUT', `/trips/${id}`, t),
      deleteTrip: (id: string) => json<void>('DELETE', `/trips/${id}`),
      inbox: () => json<Trip[]>('GET', '/trips/inbox'),
      classify: (id: string, classification: ClassifyInput['classification']) =>
        json<Trip>('POST', `/trips/${id}/classify`, { classification }),
      activeTrip: () => json<{ trip: Trip | null }>('GET', '/trips/active'),
      startTrip: (t: TripStartInput) => json<Trip>('POST', '/trips/start', t),
      endTrip: (id: string, t: TripEndInput) => json<Trip>('POST', `/trips/${id}/end`, t),
      lastOdometer: (vehicleId: string) =>
        json<{ lastOdometer: number | null }>('GET', `/vehicles/${vehicleId}/odometer`),
      teslaStatus: () => json<TeslaStatus>('GET', '/tesla/status'),
      teslaConnect: () => json<{ url: string }>('POST', '/tesla/connect'),
      teslaCallback: (code: string, state: string) =>
        json<{ connected: boolean; vehicles: Vehicle[] }>('POST', '/tesla/callback', { code, state }),
      summary: (r: Range) => json<ReportSummary>('GET', `/reports/summary?${qs(r)}`),
      /** Raw report download (CSV or PDF) with auth applied. */
      report: (kind: 'csv' | 'pdf', r: Range) => raw('GET', `/reports/log.${kind}?${qs(r)}`),
    };
  }, [getAccessToken]);
}
