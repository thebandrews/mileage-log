import type pg from 'pg';
import {
  classifySchema,
  dateRangeSchema,
  fieldErrors,
  localDate,
  settingsInputSchema,
  summarizeTrips,
  tripEndSchema,
  tripInputSchema,
  tripStartSchema,
  tripsToCsv,
  utcBoundsForLocalRange,
  vehicleInputSchema,
} from '@mileage/shared';
import type { z } from 'zod';
import type { Authenticator } from './auth.js';
import { migrate } from './db.js';
import { noGeocoder, type Geocoder } from './geocode.js';
import { HttpError, Router, errorResponse, noContent, ok, type ApiRequest, type ApiResponse } from './http.js';
import { renderLogPdf } from './pdf.js';
import { Repo, type Point, type UserRecord } from './repo.js';
import { TeslaClient, TeslaError, type TeslaReading } from './tesla.js';

interface Ctx {
  req: ApiRequest;
  user: UserRecord;
  repo: Repo;
  geocoder: Geocoder;
  tesla: TeslaClient | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(422, 'Validation failed', fieldErrors(r.error));
  return r.data;
}

async function body(req: ApiRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

function id(params: Record<string, string>): string {
  if (!UUID.test(params.id)) throw new HttpError(404, 'Not found');
  return params.id;
}

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD, defaulting to the current month in the user's time zone. */
function range(ctx: Ctx): { from: string; to: string; start: Date; end: Date } {
  const q = ctx.req.query;
  let from = q.get('from');
  let to = q.get('to');
  if (!from || !to) {
    const today = localDate(new Date().toISOString(), ctx.user.timezone);
    const [y, m] = today.split('-').map(Number);
    from = `${today.slice(0, 7)}-01`;
    to = `${today.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  }
  const r = parse(dateRangeSchema, { from, to });
  const [start, end] = utcBoundsForLocalRange(r.from, r.to, ctx.user.timezone);
  return { ...r, start, end };
}

async function checkVehicle(ctx: Ctx, vehicleId: string | null) {
  if (vehicleId && !(await ctx.repo.vehicleBelongsTo(ctx.user.id, vehicleId))) {
    throw new HttpError(422, 'Validation failed', { vehicleId: 'Unknown vehicle.' });
  }
}

function rateNote(user: UserRecord): string {
  return user.customRateCents !== null
    ? `custom rate ${user.customRateCents} cents/mi`
    : 'IRS standard business rate in effect on each trip date';
}

async function reportData(ctx: Ctx) {
  const r = range(ctx);
  const [trips, vehicles] = await Promise.all([
    ctx.repo.listTrips(ctx.user.id, r.start, r.end),
    ctx.repo.listVehicles(ctx.user.id),
  ]);
  const summary = summarizeTrips(trips, {
    from: r.from,
    to: r.to,
    timezone: ctx.user.timezone,
    customRateCents: ctx.user.customRateCents,
  });
  return { r, trips, vehicles, summary };
}

/** A label for a point: a name the user gave this spot before, else the street address. */
async function describe(ctx: Ctx, p: Point | null): Promise<{ label: string | null; address: string | null }> {
  if (!p) return { label: null, address: null };
  const [known, address] = await Promise.all([ctx.repo.knownLabelNear(ctx.user.id, p), ctx.geocoder.reverse(p)]);
  return { label: known ?? address, address };
}

/** Reads the car when the trip's vehicle is a linked Tesla and the account is connected. */
async function readTesla(ctx: Ctx, vehicleId: string | null): Promise<TeslaReading | null> {
  if (!vehicleId || !ctx.tesla) return null;
  const vehicle = await ctx.repo.getVehicle(ctx.user.id, vehicleId);
  if (!vehicle?.teslaVin || !(await ctx.repo.teslaConnected(ctx.user.id))) return null;
  try {
    return await ctx.tesla.read(ctx.user.id, vehicle.teslaVin);
  } catch (err) {
    if (err instanceof TeslaError) throw new HttpError(502, `Couldn't read the car: ${err.message}`);
    throw err;
  }
}

const router = new Router<Ctx>()
  .on('GET', '/me', async ({ user }) => ok(user))
  .on('PUT', '/settings', async (ctx) => {
    const s = parse(settingsInputSchema, await body(ctx.req));
    return ok(await ctx.repo.updateSettings(ctx.user.id, s));
  })

  .on('GET', '/vehicles', async (ctx) => ok(await ctx.repo.listVehicles(ctx.user.id)))
  .on('POST', '/vehicles', async (ctx) => {
    const v = parse(vehicleInputSchema, await body(ctx.req));
    return ok(await ctx.repo.createVehicle(ctx.user.id, v), 201);
  })
  .on('PUT', '/vehicles/:id', async (ctx, params) => {
    const v = parse(vehicleInputSchema, await body(ctx.req));
    const updated = await ctx.repo.updateVehicle(ctx.user.id, id(params), v);
    if (!updated) throw new HttpError(404, 'Not found');
    return ok(updated);
  })

  .on('GET', '/vehicles/:id/odometer', async (ctx, params) => {
    if (!(await ctx.repo.vehicleBelongsTo(ctx.user.id, id(params)))) throw new HttpError(404, 'Not found');
    return ok({ lastOdometer: await ctx.repo.lastOdometer(ctx.user.id, params.id) });
  })

  .on('GET', '/trips/active', async (ctx) => ok({ trip: await ctx.repo.activeTrip(ctx.user.id) }))
  .on('POST', '/trips/start', async (ctx) => {
    const t = parse(tripStartSchema, await body(ctx.req));
    await checkVehicle(ctx, t.vehicleId);
    const running = await ctx.repo.activeTrip(ctx.user.id);
    if (running) return { status: 409, json: { error: 'A trip is already in progress', trip: running } };

    const car = await readTesla(ctx, t.vehicleId);
    const location = car?.location ?? t.location;
    const place = await describe(ctx, location);
    const trip = await ctx.repo.startTrip(ctx.user.id, {
      vehicleId: t.vehicleId,
      startedAt: t.startedAt ?? new Date().toISOString(),
      location,
      startLabel: place.label,
      startAddress: place.address,
      startOdometer: car?.odometer ?? t.startOdometer,
    });
    if (!trip) return { status: 409, json: { error: 'A trip is already in progress', trip: await ctx.repo.activeTrip(ctx.user.id) } };
    return ok(trip, 201);
  })
  .on('POST', '/trips/:id/end', async (ctx, params) => {
    const e = parse(tripEndSchema, await body(ctx.req));
    const trip = await ctx.repo.getTrip(ctx.user.id, id(params));
    if (!trip) throw new HttpError(404, 'Not found');
    if (trip.status !== 'in_progress') throw new HttpError(409, 'This trip has already ended');

    const car = await readTesla(ctx, trip.vehicleId);
    const endOdometer = car?.odometer ?? e.endOdometer;
    let miles: number | null = null;
    let source: 'tesla' | 'manual' | 'gps' = car ? 'tesla' : 'manual';
    if (endOdometer !== null && trip.startOdometer !== null) {
      if (endOdometer <= trip.startOdometer) {
        throw new HttpError(422, 'Validation failed', {
          endOdometer: `End odometer must be greater than the start reading (${trip.startOdometer}).`,
        });
      }
      miles = Math.round((endOdometer - trip.startOdometer) * 10) / 10;
    } else if (e.gpsMiles !== null) {
      miles = Math.round(e.gpsMiles * 10) / 10;
      source = 'gps';
    } else if (e.miles !== null) {
      miles = Math.round(e.miles * 10) / 10;
    }
    if (miles === null || miles <= 0) {
      throw new HttpError(
        422,
        'Validation failed',
        trip.startOdometer === null
          ? { miles: 'Enter the miles for this trip.' }
          : { endOdometer: 'Enter the end odometer reading.' },
      );
    }
    const location = car?.location ?? e.location;
    const place = await describe(ctx, location);
    const ended = await ctx.repo.endTrip(ctx.user.id, trip.id, {
      endedAt: e.endedAt ?? new Date().toISOString(),
      location,
      endLabel: place.label,
      endAddress: place.address,
      endOdometer,
      miles,
      source,
    });
    if (!ended) throw new HttpError(409, 'This trip has already ended');
    return ok(ended);
  })

  .on('GET', '/tesla/status', async (ctx) =>
    ok({ configured: ctx.tesla !== null, connected: await ctx.repo.teslaConnected(ctx.user.id) }),
  )
  .on('POST', '/tesla/connect', async (ctx) => {
    if (!ctx.tesla) throw new HttpError(503, 'The Tesla connection is not set up yet');
    const state = TeslaClient.newState();
    await ctx.repo.saveOAuthState(ctx.user.id, state);
    return ok({ url: ctx.tesla.authorizeUrl(state) });
  })
  .on('POST', '/tesla/callback', async (ctx) => {
    if (!ctx.tesla) throw new HttpError(503, 'The Tesla connection is not set up yet');
    const b = (await body(ctx.req)) as { code?: unknown; state?: unknown };
    if (typeof b.code !== 'string' || typeof b.state !== 'string') throw new HttpError(400, 'Missing code or state');
    if (!(await ctx.repo.consumeOAuthState(ctx.user.id, b.state))) {
      throw new HttpError(400, 'This Tesla sign-in link expired. Start again from Settings.');
    }
    try {
      await ctx.tesla.connect(ctx.user.id, b.code);
      await ctx.repo.markTeslaConnected(ctx.user.id);
      // Link each car: reuse a lone unlinked Tesla vehicle the user already added, else create one.
      const cars = await ctx.tesla.listVehicles(ctx.user.id);
      const existing = await ctx.repo.listVehicles(ctx.user.id);
      const unlinked = existing.filter((v) => v.isTesla && !v.teslaVin && !v.archived);
      const vehicles = [];
      for (const car of cars) {
        if (existing.some((v) => v.teslaVin === car.vin)) continue;
        if (cars.length === 1 && unlinked.length === 1) {
          vehicles.push(await ctx.repo.upsertTeslaVehicle(ctx.user.id, car.vin, car.name, unlinked[0].id));
        } else {
          vehicles.push(await ctx.repo.upsertTeslaVehicle(ctx.user.id, car.vin, car.name));
        }
      }
      return ok({ connected: true, vehicles: await ctx.repo.listVehicles(ctx.user.id) });
    } catch (err) {
      if (err instanceof TeslaError) throw new HttpError(502, err.message);
      throw err;
    }
  })

  .on('GET', '/trips/inbox', async (ctx) => ok(await ctx.repo.inbox(ctx.user.id)))
  .on('POST', '/trips/:id/classify', async (ctx, params) => {
    const { classification } = parse(classifySchema, await body(ctx.req));
    const trip = await ctx.repo.getTrip(ctx.user.id, id(params));
    if (!trip || trip.status !== 'finished') throw new HttpError(404, 'Not found');
    if (classification === 'business' && (!trip.endLabel?.trim() || !trip.purpose?.trim())) {
      throw new HttpError(422, 'Validation failed', {
        ...(!trip.endLabel?.trim() && { endLabel: 'Business trips need a destination.' }),
        ...(!trip.purpose?.trim() && { purpose: 'Business trips need a purpose.' }),
      });
    }
    return ok(await ctx.repo.classifyTrip(ctx.user.id, trip.id, classification));
  })
  .on('GET', '/trips', async (ctx) => {
    const r = range(ctx);
    return ok(await ctx.repo.listTrips(ctx.user.id, r.start, r.end));
  })
  .on('POST', '/trips', async (ctx) => {
    const t = parse(tripInputSchema, await body(ctx.req));
    await checkVehicle(ctx, t.vehicleId);
    return ok(await ctx.repo.createTrip(ctx.user.id, t), 201);
  })
  .on('GET', '/trips/:id', async (ctx, params) => {
    const trip = await ctx.repo.getTrip(ctx.user.id, id(params));
    if (!trip) throw new HttpError(404, 'Not found');
    return ok(trip);
  })
  .on('PUT', '/trips/:id', async (ctx, params) => {
    const t = parse(tripInputSchema, await body(ctx.req));
    await checkVehicle(ctx, t.vehicleId);
    const trip = await ctx.repo.updateTrip(ctx.user.id, id(params), t);
    if (!trip) throw new HttpError(404, 'Not found');
    return ok(trip);
  })
  .on('DELETE', '/trips/:id', async (ctx, params) => {
    if (!(await ctx.repo.deleteTrip(ctx.user.id, id(params)))) throw new HttpError(404, 'Not found');
    return noContent();
  })

  .on('GET', '/reports/summary', async (ctx) => ok((await reportData(ctx)).summary))
  .on('GET', '/reports/log.csv', async (ctx) => {
    const { r, trips, vehicles } = await reportData(ctx);
    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="mileage-log_${r.from}_${r.to}.csv"`,
      },
      // Byte-order mark so Excel opens UTF-8 (accents, dashes) correctly.
      body: '﻿' + tripsToCsv(trips, vehicles, ctx.user.timezone),
    };
  })
  .on('GET', '/reports/log.pdf', async (ctx) => {
    const { r, trips, vehicles, summary } = await reportData(ctx);
    const pdf = await renderLogPdf({
      title: 'Mileage log',
      ownerName: ctx.user.name,
      trips,
      vehicles,
      summary,
      rateNote: rateNote(ctx.user),
    });
    return {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="mileage-log_${r.from}_${r.to}.pdf"`,
      },
      body: pdf,
    };
  });

export interface App {
  handle(req: ApiRequest): Promise<ApiResponse>;
}

export interface AppOptions {
  autoMigrate?: boolean;
  geocoder?: Geocoder;
  tesla?: TeslaClient | null;
}

export function createApp(pool: pg.Pool, authenticate: Authenticator, opts: AppOptions = {}): App {
  const repo = new Repo(pool);
  const geocoder = opts.geocoder ?? noGeocoder;
  const tesla = opts.tesla ?? null;
  let ready: Promise<unknown> | null = null;
  const ensureReady = () => {
    if (opts.autoMigrate === false) return Promise.resolve();
    ready ??= migrate(pool, console.log).catch((err) => {
      ready = null; // retry on the next request
      throw err;
    });
    return ready;
  };

  return {
    async handle(req) {
      try {
        if (req.method === 'GET' && req.path.replace(/\/$/, '') === '/health') {
          await pool.query('SELECT 1');
          return ok({ ok: true });
        }
        const match = router.match(req.method, req.path);
        if (match === null) throw new HttpError(404, 'Not found');
        if (match === 'method') throw new HttpError(405, 'Method not allowed');
        const identity = await authenticate(req);
        await ensureReady();
        const user = await repo.upsertUser(identity);
        return await match.handler({ req, user, repo, geocoder, tesla }, match.params);
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
}
