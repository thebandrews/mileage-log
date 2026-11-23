import type pg from 'pg';
import {
  dateRangeSchema,
  fieldErrors,
  localDate,
  settingsInputSchema,
  summarizeTrips,
  tripInputSchema,
  tripsToCsv,
  utcBoundsForLocalRange,
  vehicleInputSchema,
} from '@mileage/shared';
import type { z } from 'zod';
import type { Authenticator } from './auth.js';
import { migrate } from './db.js';
import { HttpError, Router, errorResponse, noContent, ok, type ApiRequest, type ApiResponse } from './http.js';
import { renderLogPdf } from './pdf.js';
import { Repo, type UserRecord } from './repo.js';

interface Ctx {
  req: ApiRequest;
  user: UserRecord;
  repo: Repo;
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

export function createApp(pool: pg.Pool, authenticate: Authenticator, opts: { autoMigrate?: boolean } = {}): App {
  const repo = new Repo(pool);
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
        return await match.handler({ req, user, repo }, match.params);
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
}
