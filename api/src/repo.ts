import type pg from 'pg';
import type { Classification, NormalizedTripInput, Settings, Trip, TripSource, User, Vehicle } from '@mileage/shared';
import type { Identity } from './auth.js';

export interface UserRecord extends User, Settings {}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const iso = (v: Date | null): string | null => (v ? v.toISOString() : null);

function toTrip(r: any): Trip {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    startLabel: r.start_label,
    endLabel: r.end_label,
    startOdometer: num(r.start_odometer),
    endOdometer: num(r.end_odometer),
    miles: num(r.miles) ?? 0,
    status: r.status,
    startLat: r.start_lat,
    startLng: r.start_lng,
    endLat: r.end_lat,
    endLng: r.end_lng,
    classification: r.classification,
    purpose: r.purpose,
    client: r.client,
    notes: r.notes,
    source: r.source,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

function toVehicle(r: any): Vehicle {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    isTesla: r.is_tesla,
    qualifiedNonpersonalUse: r.qualified_nonpersonal_use,
    archived: r.archived,
    teslaVin: r.tesla_vin,
    createdAt: iso(r.created_at)!,
  };
}

function toUser(r: any): UserRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    timezone: r.timezone,
    customRateCents: num(r.custom_rate_cents),
  };
}

const TRIP_COLUMNS = `id, vehicle_id, started_at, ended_at, start_label, end_label, start_odometer, end_odometer,
  miles, status, start_lat, start_lng, end_lat, end_lng, classification, purpose, client, notes, source,
  created_at, updated_at`;

export interface Point {
  latitude: number;
  longitude: number;
}

export interface StartTripRecord {
  vehicleId: string | null;
  startedAt: string;
  location: Point | null;
  startLabel: string | null;
  startAddress: string | null;
  startOdometer: number | null;
}

export interface EndTripRecord {
  endedAt: string;
  location: Point | null;
  endLabel: string | null;
  endAddress: string | null;
  endOdometer: number | null;
  miles: number;
  source: TripSource;
}

/** Metres between two points (haversine). */
export function distanceMeters(a: Point, b: Point): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** All queries are scoped to one user; nothing here can read another user's rows. */
export class Repo {
  constructor(private readonly db: pg.Pool) {}

  async upsertUser(identity: Identity): Promise<UserRecord> {
    const { rows } = await this.db.query(
      `INSERT INTO users (entra_oid, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (entra_oid) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, users.email), name = COALESCE(EXCLUDED.name, users.name)
       RETURNING *`,
      [identity.oid, identity.email, identity.name],
    );
    return toUser(rows[0]);
  }

  async updateSettings(userId: string, s: Partial<Settings>): Promise<UserRecord> {
    const { rows } = await this.db.query(
      `UPDATE users SET
         timezone = COALESCE($2, timezone),
         custom_rate_cents = CASE WHEN $3::boolean THEN $4::numeric ELSE custom_rate_cents END
       WHERE id = $1 RETURNING *`,
      [userId, s.timezone ?? null, s.customRateCents !== undefined, s.customRateCents ?? null],
    );
    return toUser(rows[0]);
  }

  // Vehicles

  async listVehicles(userId: string): Promise<Vehicle[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM vehicles WHERE user_id = $1 ORDER BY archived, created_at',
      [userId],
    );
    return rows.map(toVehicle);
  }

  async getVehicle(userId: string, id: string): Promise<Vehicle | null> {
    const { rows } = await this.db.query('SELECT * FROM vehicles WHERE user_id = $1 AND id = $2', [userId, id]);
    return rows[0] ? toVehicle(rows[0]) : null;
  }

  async createVehicle(userId: string, v: Omit<Vehicle, 'id' | 'createdAt' | 'teslaVin'>): Promise<Vehicle> {
    const { rows } = await this.db.query(
      `INSERT INTO vehicles (user_id, name, kind, is_tesla, qualified_nonpersonal_use, archived)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, v.name, v.kind, v.isTesla, v.qualifiedNonpersonalUse, v.archived],
    );
    return toVehicle(rows[0]);
  }

  async updateVehicle(
    userId: string,
    id: string,
    v: Omit<Vehicle, 'id' | 'createdAt' | 'teslaVin'>,
  ): Promise<Vehicle | null> {
    const { rows } = await this.db.query(
      `UPDATE vehicles SET name = $3, kind = $4, is_tesla = $5, qualified_nonpersonal_use = $6, archived = $7
       WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, v.name, v.kind, v.isTesla, v.qualifiedNonpersonalUse, v.archived],
    );
    return rows[0] ? toVehicle(rows[0]) : null;
  }

  async vehicleBelongsTo(userId: string, vehicleId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM vehicles WHERE user_id = $1 AND id = $2', [
      userId,
      vehicleId,
    ]);
    return rowCount === 1;
  }

  /** Links a Tesla by VIN: to `vehicleId` when given, else the vehicle already linked, else a new one. */
  async upsertTeslaVehicle(userId: string, vin: string, name: string, vehicleId?: string): Promise<Vehicle> {
    if (vehicleId) {
      const { rows } = await this.db.query(
        'UPDATE vehicles SET tesla_vin = $3, is_tesla = true WHERE user_id = $1 AND id = $2 RETURNING *',
        [userId, vehicleId, vin],
      );
      if (rows[0]) return toVehicle(rows[0]);
    }
    const { rows } = await this.db.query(
      `INSERT INTO vehicles (user_id, name, kind, is_tesla, tesla_vin)
       VALUES ($1, $2, 'car', true, $3)
       ON CONFLICT (user_id, tesla_vin) WHERE tesla_vin IS NOT NULL DO UPDATE SET is_tesla = true
       RETURNING *`,
      [userId, name, vin],
    );
    return toVehicle(rows[0]);
  }

  /** Most recent odometer reading for a vehicle, to pre-fill the next start. */
  async lastOdometer(userId: string, vehicleId: string): Promise<number | null> {
    const { rows } = await this.db.query(
      `SELECT GREATEST(COALESCE(end_odometer, 0), COALESCE(start_odometer, 0)) AS odo FROM trips
       WHERE user_id = $1 AND vehicle_id = $2 AND deleted_at IS NULL
         AND (end_odometer IS NOT NULL OR start_odometer IS NOT NULL)
       ORDER BY started_at DESC LIMIT 1`,
      [userId, vehicleId],
    );
    return rows[0] ? Number(rows[0].odo) : null;
  }

  // Trips

  /** Finished trips that started in [start, end), newest first. */
  async listTrips(userId: string, start: Date, end: Date): Promise<Trip[]> {
    const { rows } = await this.db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips
       WHERE user_id = $1 AND deleted_at IS NULL AND status = 'finished' AND started_at >= $2 AND started_at < $3
       ORDER BY started_at DESC`,
      [userId, start, end],
    );
    return rows.map(toTrip);
  }

  async getTrip(userId: string, id: string): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [userId, id],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async activeTrip(userId: string): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL`,
      [userId],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  /** Inserts an in-progress trip; null if one is already running. */
  async startTrip(userId: string, t: StartTripRecord): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `INSERT INTO trips (user_id, vehicle_id, started_at, start_lat, start_lng, start_label, start_address,
         start_odometer, status, classification, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', 'unclassified', 'manual')
       ON CONFLICT (user_id) WHERE status = 'in_progress' AND deleted_at IS NULL DO NOTHING
       RETURNING ${TRIP_COLUMNS}`,
      [
        userId,
        t.vehicleId,
        t.startedAt,
        t.location?.latitude ?? null,
        t.location?.longitude ?? null,
        t.startLabel,
        t.startAddress,
        t.startOdometer,
      ],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async endTrip(userId: string, id: string, t: EndTripRecord): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `UPDATE trips SET ended_at = $3, end_lat = $4, end_lng = $5, end_label = $6, end_address = $7,
         end_odometer = $8, miles = $9, source = $10, status = 'finished', updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status = 'in_progress' AND deleted_at IS NULL
       RETURNING ${TRIP_COLUMNS}`,
      [
        userId,
        id,
        t.endedAt,
        t.location?.latitude ?? null,
        t.location?.longitude ?? null,
        t.endLabel,
        t.endAddress,
        t.endOdometer,
        t.miles,
        t.source,
      ],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  /**
   * A name the user gave this spot before ("Yard", "Smith residence"): the most recent trip that
   * started or ended within `radius` metres and whose label differs from the geocoded address.
   */
  async knownLabelNear(userId: string, p: Point, radius = 150): Promise<string | null> {
    const dLat = radius / 111_000;
    const dLng = radius / (111_000 * Math.max(Math.cos((p.latitude * Math.PI) / 180), 0.01));
    const { rows } = await this.db.query(
      `SELECT label, lat, lng FROM (
         SELECT end_label AS label, end_lat AS lat, end_lng AS lng, updated_at FROM trips
           WHERE user_id = $1 AND deleted_at IS NULL AND end_label IS NOT NULL
             AND end_label IS DISTINCT FROM end_address
             AND end_lat BETWEEN $2 AND $3 AND end_lng BETWEEN $4 AND $5
         UNION ALL
         SELECT start_label, start_lat, start_lng, updated_at FROM trips
           WHERE user_id = $1 AND deleted_at IS NULL AND start_label IS NOT NULL
             AND start_label IS DISTINCT FROM start_address
             AND start_lat BETWEEN $2 AND $3 AND start_lng BETWEEN $4 AND $5
       ) near ORDER BY updated_at DESC LIMIT 10`,
      [userId, p.latitude - dLat, p.latitude + dLat, p.longitude - dLng, p.longitude + dLng],
    );
    const hit = rows.find((r) => distanceMeters(p, { latitude: r.lat, longitude: r.lng }) <= radius);
    return hit?.label ?? null;
  }

  async createTrip(userId: string, t: NormalizedTripInput): Promise<Trip> {
    const { rows } = await this.db.query(
      `INSERT INTO trips (user_id, vehicle_id, started_at, ended_at, start_label, end_label, start_odometer,
         end_odometer, miles, classification, purpose, client, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${TRIP_COLUMNS}`,
      [userId, ...tripValues(t)],
    );
    return toTrip(rows[0]);
  }

  /** Edits a finished trip; location and geocoded addresses are kept. */
  async updateTrip(userId: string, id: string, t: NormalizedTripInput): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `UPDATE trips SET vehicle_id = $3, started_at = $4, ended_at = $5, start_label = $6, end_label = $7,
         start_odometer = $8, end_odometer = $9, miles = $10, classification = $11, purpose = $12,
         client = $13, notes = $14, source = $15, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'finished'
       RETURNING ${TRIP_COLUMNS}`,
      [userId, id, ...tripValues(t)],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  /** Finished trips still waiting for Business or Personal, newest first. */
  async inbox(userId: string, limit = 50): Promise<Trip[]> {
    const { rows } = await this.db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips
       WHERE user_id = $1 AND deleted_at IS NULL AND status = 'finished' AND classification = 'unclassified'
       ORDER BY started_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toTrip);
  }

  async classifyTrip(userId: string, id: string, classification: Classification): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `UPDATE trips SET classification = $3, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING ${TRIP_COLUMNS}`,
      [userId, id, classification],
    );
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async deleteTrip(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE trips SET deleted_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL',
      [userId, id],
    );
    return rowCount === 1;
  }

  // Tesla

  async teslaConnected(userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM tesla_accounts WHERE user_id = $1', [userId]);
    return rowCount === 1;
  }

  async markTeslaConnected(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tesla_accounts (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET connected_at = now()`,
      [userId],
    );
  }

  async saveOAuthState(userId: string, state: string): Promise<void> {
    await this.db.query("DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'");
    await this.db.query('INSERT INTO oauth_states (state, user_id) VALUES ($1, $2)', [state, userId]);
  }

  /** One-time use: true if this user created the state in the last 15 minutes. */
  async consumeOAuthState(userId: string, state: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM oauth_states WHERE state = $1 AND user_id = $2 AND created_at > now() - interval '15 minutes'`,
      [state, userId],
    );
    return rowCount === 1;
  }
}

function tripValues(t: NormalizedTripInput): unknown[] {
  return [
    t.vehicleId,
    t.startedAt,
    t.endedAt,
    t.startLabel,
    t.endLabel,
    t.startOdometer,
    t.endOdometer,
    t.miles,
    t.classification,
    t.purpose,
    t.client,
    t.notes,
    t.source,
  ];
}
