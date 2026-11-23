import type pg from 'pg';
import type {
  NormalizedTripInput,
  Settings,
  Trip,
  User,
  Vehicle,
} from '@mileage/shared';
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
    miles: Number(r.miles),
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
  miles, classification, purpose, client, notes, source, created_at, updated_at`;

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

  async createVehicle(userId: string, v: Omit<Vehicle, 'id' | 'createdAt'>): Promise<Vehicle> {
    const { rows } = await this.db.query(
      `INSERT INTO vehicles (user_id, name, kind, is_tesla, qualified_nonpersonal_use, archived)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, v.name, v.kind, v.isTesla, v.qualifiedNonpersonalUse, v.archived],
    );
    return toVehicle(rows[0]);
  }

  async updateVehicle(userId: string, id: string, v: Omit<Vehicle, 'id' | 'createdAt'>): Promise<Vehicle | null> {
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

  // Trips

  /** Trips that started in [start, end), newest first. */
  async listTrips(userId: string, start: Date, end: Date): Promise<Trip[]> {
    const { rows } = await this.db.query(
      `SELECT ${TRIP_COLUMNS} FROM trips
       WHERE user_id = $1 AND deleted_at IS NULL AND started_at >= $2 AND started_at < $3
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

  async updateTrip(userId: string, id: string, t: NormalizedTripInput): Promise<Trip | null> {
    const { rows } = await this.db.query(
      `UPDATE trips SET vehicle_id = $3, started_at = $4, ended_at = $5, start_label = $6, end_label = $7,
         start_odometer = $8, end_odometer = $9, miles = $10, classification = $11, purpose = $12,
         client = $13, notes = $14, source = $15, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING ${TRIP_COLUMNS}`,
      [userId, id, ...tripValues(t)],
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
