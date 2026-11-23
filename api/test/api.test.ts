import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { createAuthenticator } from '../src/auth.js';
import type { ApiRequest } from '../src/http.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

function request(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): ApiRequest {
  const u = new URL(url, 'http://test');
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    path: u.pathname,
    query: u.searchParams,
    header: (n) => headers.get(n.toLowerCase()) ?? null,
    json: async () => {
      if (typeof opts.body === 'string') return JSON.parse(opts.body);
      return opts.body;
    },
  };
}

describeDb('API against Postgres', () => {
  let pool: pg.Pool;
  let app: App;
  const as = (user: string) => ({ 'x-dev-user': user });
  const call = (method: string, url: string, body?: unknown, user = 'ben') =>
    app.handle(request(method, url, { body, headers: as(user) }));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    app = createApp(pool, createAuthenticator({ authMode: 'dev', tenantId: null, apiClientId: null }));
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    // First test triggers migrations through the app; afterwards just clear rows.
    await call('GET', '/me');
    await pool.query('TRUNCATE trips, vehicles, users CASCADE');
  });

  it('serves health without auth and rejects anonymous requests', async () => {
    expect((await app.handle(request('GET', '/health'))).status).toBe(200);
    expect((await app.handle(request('GET', '/trips'))).status).toBe(401);
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('PATCH', '/trips')).status).toBe(405);
  });

  it('creates the user on first call with Pacific time by default', async () => {
    const me = await call('GET', '/me');
    expect(me.json).toMatchObject({ name: 'ben', timezone: 'America/Los_Angeles', customRateCents: null });
  });

  it('runs the trip lifecycle: create, list, update, delete', async () => {
    const vehicle = await call('POST', '/vehicles', { name: 'Model Y', kind: 'car', isTesla: true });
    expect(vehicle.status).toBe(201);
    const vehicleId = (vehicle.json as { id: string }).id;

    const created = await call('POST', '/trips', {
      vehicleId,
      startedAt: '2026-11-03T08:15:00-08:00',
      startOdometer: 15020.4,
      endOdometer: 15032.8,
      classification: 'business',
      startLabel: 'Yard',
      endLabel: 'Smith residence, Ballard',
      purpose: 'Site walk for spring install',
      client: 'Smith',
    });
    expect(created.status).toBe(201);
    const trip = created.json as { id: string; miles: number; startedAt: string };
    expect(trip.miles).toBe(12.4);
    expect(trip.startedAt).toBe('2026-11-03T16:15:00.000Z');

    const list = await call('GET', '/trips?from=2026-11-01&to=2026-11-30');
    expect((list.json as unknown[]).length).toBe(1);
    const october = await call('GET', '/trips?from=2026-10-01&to=2026-10-31');
    expect(october.json).toEqual([]);

    const updated = await call('PUT', `/trips/${trip.id}`, {
      vehicleId,
      startedAt: '2026-11-03T08:15:00-08:00',
      miles: 13,
      classification: 'personal',
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ miles: 13, classification: 'personal', startOdometer: null });

    expect((await call('DELETE', `/trips/${trip.id}`)).status).toBe(204);
    expect((await call('GET', `/trips/${trip.id}`)).status).toBe(404);
    expect((await call('DELETE', `/trips/${trip.id}`)).status).toBe(404);
  });

  it('returns field errors for invalid trips', async () => {
    const res = await call('POST', '/trips', { startedAt: '2026-11-03T08:00:00Z', classification: 'business', miles: 3 });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ fields: { endLabel: expect.any(String), purpose: expect.any(String) } });
    expect((await call('GET', '/trips/not-a-uuid')).status).toBe(404);
    expect((await call('GET', '/trips?from=2026-11-30&to=2026-11-01')).status).toBe(422);
  });

  it('keeps users isolated from each other', async () => {
    const mine = await call('POST', '/vehicles', { name: 'Truck 1', kind: 'truck' });
    const vehicleId = (mine.json as { id: string }).id;
    const trip = await call('POST', '/trips', { startedAt: '2026-11-03T08:00:00Z', miles: 4 });
    const tripId = (trip.json as { id: string }).id;

    expect((await call('GET', `/trips/${tripId}`, undefined, 'mallory')).status).toBe(404);
    expect((await call('DELETE', `/trips/${tripId}`, undefined, 'mallory')).status).toBe(404);
    expect((await call('GET', '/vehicles', undefined, 'mallory')).json).toEqual([]);
    const stolen = await call('POST', '/trips', { vehicleId, startedAt: '2026-11-03T08:00:00Z', miles: 4 }, 'mallory');
    expect(stolen.status).toBe(422);
  });

  it('summarizes and exports a month as CSV and PDF', async () => {
    await call('POST', '/trips', {
      startedAt: '2026-11-03T08:00:00-08:00',
      miles: 20,
      classification: 'business',
      endLabel: 'Sky Nursery',
      purpose: 'Materials pickup',
    });
    await call('POST', '/trips', { startedAt: '2026-11-04T18:00:00-08:00', miles: 5.5, classification: 'personal' });
    await call('POST', '/trips', { startedAt: '2026-12-01T09:00:00-08:00', miles: 99, classification: 'business', endLabel: 'X', purpose: 'Y' });

    const summary = await call('GET', '/reports/summary?from=2026-11-01&to=2026-11-30');
    expect(summary.json).toMatchObject({
      totals: { business: 20, personal: 5.5, total: 25.5, trips: 2, businessValueCents: 1520 },
      byDay: [{ period: '2026-11-03' }, { period: '2026-11-04' }],
    });

    const csv = await call('GET', '/reports/log.csv?from=2026-11-01&to=2026-11-30');
    expect(csv.headers?.['content-type']).toMatch(/text\/csv/);
    const lines = String(csv.body).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-11-03,08:00,,,,,20.0,business,,Sky Nursery,Materials pickup');

    const pdf = await call('GET', '/reports/log.pdf?from=2026-11-01&to=2026-11-30');
    expect(pdf.headers?.['content-type']).toBe('application/pdf');
    const bytes = pdf.body as Uint8Array;
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('applies a custom rate from settings', async () => {
    await call('PUT', '/settings', { customRateCents: 50 });
    await call('POST', '/trips', {
      startedAt: '2026-11-03T08:00:00-08:00',
      miles: 10,
      classification: 'business',
      endLabel: 'A',
      purpose: 'B',
    });
    const s = await call('GET', '/reports/summary?from=2026-11-01&to=2026-11-30');
    expect((s.json as { totals: { businessValueCents: number } }).totals.businessValueCents).toBe(500);
    expect((await call('PUT', '/settings', { timezone: 'Mars/Olympus' })).status).toBe(422);
  });
});

describe('Entra token validation', () => {
  const tenant = '11111111-1111-1111-1111-111111111111';
  const apiClientId = '22222222-2222-2222-2222-222222222222';
  let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string }) => Promise<string>;
  let authenticate: ReturnType<typeof createAuthenticator>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    authenticate = createAuthenticator(
      { authMode: 'entra', tenantId: tenant, apiClientId },
      createLocalJWKSet({ keys: [jwk] }),
    );
    sign = (claims, opts = {}) =>
      new SignJWT({ tid: tenant, oid: 'user-oid', scp: 'access_as_user', name: 'Ben', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(opts.issuer ?? `https://login.microsoftonline.com/${tenant}/v2.0`)
        .setAudience(opts.audience ?? apiClientId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
  });

  const withToken = (token: string) => request('GET', '/me', { headers: { authorization: `Bearer ${token}` } });
  const status = (p: Promise<unknown>) =>
    p.then(
      () => 200,
      (e: { status: number }) => e.status,
    );

  it('accepts a valid token for the API', async () => {
    const id = await authenticate(withToken(await sign({ preferred_username: 'ben@pacificalandscapesseattle.com' })));
    expect(id).toEqual({ oid: 'user-oid', email: 'ben@pacificalandscapesseattle.com', name: 'Ben' });
    expect(await status(authenticate(withToken(await sign({}, { audience: `api://${apiClientId}` }))))).toBe(200);
  });

  it('rejects missing, foreign, mis-scoped and wrong-audience tokens', async () => {
    expect(await status(authenticate(request('GET', '/me')))).toBe(401);
    expect(await status(authenticate(withToken(await sign({}, { audience: 'someone-else' }))))).toBe(401);
    expect(await status(authenticate(withToken(await sign({}, { issuer: 'https://evil.example/v2.0' }))))).toBe(401);
    expect(await status(authenticate(withToken(await sign({ scp: 'User.Read' }))))).toBe(403);
    expect(await status(authenticate(withToken(await sign({ tid: 'other-tenant' }))))).toBe(403);
    expect(await status(authenticate(withToken('not.a.jwt')))).toBe(401);
  });
});

describe('createPool', () => {
  it('uses a fresh Entra token as the password when PG_AUTH=entra', async () => {
    const { createPool, POSTGRES_TOKEN_SCOPE } = await import('../src/db.js');
    const scopes: string[] = [];
    const pool = createPool({ PG_AUTH: 'entra', PGHOST: 'example.invalid' } as NodeJS.ProcessEnv, {
      getToken: async (scope) => {
        scopes.push(scope);
        return { token: 'entra-token' };
      },
    });
    const password = (pool as unknown as { options: { password: () => Promise<string> } }).options.password;
    expect(typeof password).toBe('function');
    expect(await password()).toBe('entra-token');
    expect(scopes).toEqual([POSTGRES_TOKEN_SCOPE]);
    await pool.end();
  });

  it('leaves password auth alone otherwise', async () => {
    const { createPool } = await import('../src/db.js');
    const pool = createPool({ DATABASE_URL: 'postgres://u:p@localhost/db' } as NodeJS.ProcessEnv);
    expect((pool as unknown as { options: { password?: unknown } }).options.password).toBeUndefined();
    await pool.end();
  });
});
