import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { createAuthenticator } from '../src/auth.js';
import { formatAddress, type Geocoder } from '../src/geocode.js';
import type { ApiRequest } from '../src/http.js';
import { MemoryTokenStore, TeslaClient } from '../src/tesla.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

function request(method: string, url: string, body?: unknown, user = 'ben'): ApiRequest {
  const u = new URL(url, 'http://test');
  return {
    method,
    path: u.pathname,
    query: u.searchParams,
    header: (n) => (n.toLowerCase() === 'x-dev-user' ? user : null),
    json: async () => body,
  };
}

const YARD = { latitude: 47.7196, longitude: -122.2947 };
const SMITH = { latitude: 47.6761, longitude: -122.3871 };
const NEAR_SMITH = { latitude: 47.6765, longitude: -122.3869 }; // ~50 m away

/** Geocoder that knows two addresses. */
const geocoder: Geocoder = {
  reverse: async (p) =>
    Math.abs(p.latitude - YARD.latitude) < 0.01 ? '12500 Lake City Way NE, Seattle' : '6500 32nd Ave NW, Seattle',
};

/** Fake Tesla: token endpoint, vehicle list, and vehicle_data that is asleep on the first call. */
function fakeTesla() {
  const calls: string[] = [];
  let odometer = 15020.44;
  let asleepOnce = true;
  let refreshN = 0;
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/oauth2/v3/token')) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
        return json(400, { error: 'invalid_grant' });
      }
      refreshN++;
      return json(200, { access_token: `access-${refreshN}`, refresh_token: `refresh-${refreshN}`, expires_in: 28800 });
    }
    if (url.endsWith('/api/1/vehicles')) {
      return json(200, { response: [{ vin: '7SAYGDEE1PA000001', display_name: 'Model Y' }], count: 1 });
    }
    if (url.includes('/wake_up')) return json(200, { response: { state: 'online' } });
    if (url.includes('/vehicle_data')) {
      if (asleepOnce) {
        asleepOnce = false;
        return json(408, { error: 'vehicle unavailable: vehicle is offline or asleep' });
      }
      const at = odometer < 15030 ? YARD : SMITH;
      return json(200, {
        response: {
          vin: '7SAYGDEE1PA000001',
          vehicle_state: { odometer },
          drive_state: { latitude: at.latitude, longitude: at.longitude },
        },
      });
    }
    return json(404, { error: 'not found' });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    drive: (miles: number) => {
      odometer += miles;
    },
  };
}

describeDb('Start/End trips and Tesla', () => {
  let pool: pg.Pool;
  let app: App;
  let tesla: ReturnType<typeof fakeTesla>;
  let store: MemoryTokenStore;
  const call = (method: string, url: string, body?: unknown, user = 'ben') => app.handle(request(method, url, body, user));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    tesla = fakeTesla();
    store = new MemoryTokenStore();
    const client = new TeslaClient(
      { clientId: 'tesla-client', clientSecret: 'shh', redirectUri: 'https://app.example/tesla/callback' },
      store,
      tesla.fetchImpl,
      async () => {},
    );
    app = createApp(pool, createAuthenticator({ authMode: 'dev', tenantId: null, apiClientId: null }), {
      geocoder,
      tesla: client,
    });
    await call('GET', '/me');
    await pool.query('TRUNCATE trips, vehicles, tesla_accounts, oauth_states, users CASCADE');
  });

  async function vehicle(body: Record<string, unknown> = { name: 'Truck 1', kind: 'truck' }) {
    return ((await call('POST', '/vehicles', body)).json as { id: string }).id;
  }

  it('starts, shows and ends a trip from odometer readings', async () => {
    const vehicleId = await vehicle();
    const started = await call('POST', '/trips/start', { vehicleId, location: YARD, startOdometer: 100 });
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ status: 'in_progress', miles: 0, startLabel: '12500 Lake City Way NE, Seattle' });
    const tripId = (started.json as { id: string }).id;

    expect((await call('GET', '/trips/active')).json).toMatchObject({ trip: { id: tripId } });
    const again = await call('POST', '/trips/start', { vehicleId });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ trip: { id: tripId } });

    // In-progress trips stay out of lists and reports.
    const today = new Date().toISOString().slice(0, 10);
    expect((await call('GET', `/trips?from=2020-01-01&to=2030-12-31`)).json).toEqual([]);

    const tooLow = await call('POST', `/trips/${tripId}/end`, { endOdometer: 99 });
    expect(tooLow.status).toBe(422);
    const ended = await call('POST', `/trips/${tripId}/end`, { location: SMITH, endOdometer: 112.4 });
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({
      status: 'finished',
      miles: 12.4,
      source: 'manual',
      classification: 'unclassified',
      endLabel: '6500 32nd Ave NW, Seattle',
    });
    expect((await call('GET', '/trips/active')).json).toEqual({ trip: null });
    expect((await call('POST', `/trips/${tripId}/end`, { endOdometer: 120 })).status).toBe(409);
    expect((await call('GET', `/vehicles/${vehicleId}/odometer`)).json).toEqual({ lastOdometer: 112.4 });
    expect(today).toBeTruthy();
  });

  it('cancels a started trip so a new one can start', async () => {
    const first = ((await call('POST', '/trips/start', { startOdometer: 50 })).json as { id: string }).id;
    expect((await call('DELETE', `/trips/${first}`)).status).toBe(204);
    expect((await call('GET', '/trips/active')).json).toEqual({ trip: null });
    expect((await call('POST', '/trips/start', { startOdometer: 50 })).status).toBe(201);
  });

  it('renames a linked Tesla without unlinking it', async () => {
    const id = await vehicle({ name: 'Tesla 071499', kind: 'car', isTesla: true });
    await pool.query("UPDATE vehicles SET tesla_vin = '7SAYGDEE1PA071499' WHERE id = $1", [id]);
    const renamed = await call('PUT', `/vehicles/${id}`, { name: 'Model Y', kind: 'car', isTesla: true });
    expect(renamed.json).toMatchObject({ name: 'Model Y', teslaVin: '7SAYGDEE1PA071499' });
  });

  it('uses GPS distance when there is no odometer, and needs one or the other', async () => {
    const tripId = ((await call('POST', '/trips/start', { location: YARD })).json as { id: string }).id;
    const missing = await call('POST', `/trips/${tripId}/end`, {});
    expect(missing.status).toBe(422);
    const ended = await call('POST', `/trips/${tripId}/end`, { gpsMiles: 3.26, location: SMITH });
    expect(ended.json).toMatchObject({ miles: 3.3, source: 'gps' });
  });

  it('takes typed miles when there is no start odometer and no GPS', async () => {
    const tripId = ((await call('POST', '/trips/start', { location: YARD })).json as { id: string }).id;
    const missing = await call('POST', `/trips/${tripId}/end`, {});
    expect(missing.json).toMatchObject({ fields: { miles: 'Enter the miles for this trip.' } });
    const ended = await call('POST', `/trips/${tripId}/end`, { miles: 7.25, location: SMITH });
    expect(ended.json).toMatchObject({ miles: 7.3, source: 'manual' });
  });

  it('lists unclassified trips in the inbox and classifies them in one tap', async () => {
    const end = async (body: Record<string, unknown>) => {
      const id = ((await call('POST', '/trips/start', { location: YARD })).json as { id: string }).id;
      return ((await call('POST', `/trips/${id}/end`, { location: SMITH, ...body })).json as { id: string }).id;
    };
    const first = await end({ gpsMiles: 4 });
    const second = await end({ gpsMiles: 6 });
    // Still in progress: not in the inbox.
    await call('POST', '/trips/start', { location: YARD });

    const inbox = (await call('GET', '/trips/inbox')).json as { id: string }[];
    expect(inbox.map((t) => t.id)).toEqual([second, first]);
    expect((await call('GET', '/trips/inbox', undefined, 'someone-else')).json).toEqual([]);

    expect((await call('POST', `/trips/${first}/classify`, { classification: 'personal' })).json).toMatchObject({
      classification: 'personal',
    });
    // Business needs a purpose first; the destination came from the geocoder.
    const business = await call('POST', `/trips/${second}/classify`, { classification: 'business' });
    expect(business.status).toBe(422);
    expect(business.json).toMatchObject({ fields: { purpose: 'Business trips need a purpose.' } });
    expect((business.json as { fields: Record<string, string> }).fields.endLabel).toBeUndefined();
    expect((await call('POST', `/trips/${second}/classify`, { classification: 'unclassified' })).status).toBe(422);
    expect((await call('POST', `/trips/${second}/classify`, { classification: 'personal' }, 'someone-else')).status).toBe(404);

    expect(((await call('GET', '/trips/inbox')).json as { id: string }[]).map((t) => t.id)).toEqual([second]);
  });

  it('reuses a name the user gave a place before', async () => {
    const first = ((await call('POST', '/trips/start', { location: YARD, startOdometer: 1 })).json as { id: string }).id;
    const ended = (await call('POST', `/trips/${first}/end`, { location: SMITH, endOdometer: 5 })).json as Record<string, unknown>;
    // The user renames the destination when classifying.
    await call('PUT', `/trips/${first}`, {
      startedAt: ended.startedAt,
      endedAt: ended.endedAt,
      startOdometer: 1,
      endOdometer: 5,
      classification: 'business',
      startLabel: 'Yard',
      endLabel: 'Smith residence',
      purpose: 'Site walk',
    });
    const second = ((await call('POST', '/trips/start', { location: YARD, startOdometer: 10 })).json as Record<string, unknown>);
    expect(second.startLabel).toBe('Yard');
    const done = await call('POST', `/trips/${second.id}/end`, { location: NEAR_SMITH, endOdometer: 14 });
    expect(done.json).toMatchObject({ endLabel: 'Smith residence' });
  });

  it('connects a Tesla and reads the car at start and end', async () => {
    expect((await call('GET', '/tesla/status')).json).toEqual({ configured: true, connected: false });
    // A Tesla the user added by hand gets linked rather than duplicated.
    const modelY = await vehicle({ name: 'My Model Y', kind: 'car', isTesla: true });

    const connect = await call('POST', '/tesla/connect');
    const url = new URL((connect.json as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://auth.tesla.com/oauth2/v3/authorize');
    expect(url.searchParams.get('client_id')).toBe('tesla-client');
    expect(url.searchParams.get('scope')).toBe('openid offline_access vehicle_device_data vehicle_location');
    const state = url.searchParams.get('state')!;

    expect((await call('POST', '/tesla/callback', { code: 'good-code', state: 'forged' })).status).toBe(400);
    expect((await call('POST', '/tesla/callback', { code: 'good-code', state }, 'mallory')).status).toBe(400);
    const linked = await call('POST', '/tesla/callback', { code: 'good-code', state });
    expect(linked.status).toBe(200);
    expect(linked.json).toMatchObject({ connected: true, vehicles: [{ id: modelY, teslaVin: '7SAYGDEE1PA000001' }] });
    expect((await call('POST', '/tesla/callback', { code: 'good-code', state })).status).toBe(400); // state is single use
    expect(store.tokens.size).toBe(1);

    // Start: the car is asleep on the first read, gets woken, then reports odometer and location.
    const started = await call('POST', '/trips/start', { vehicleId: modelY, location: SMITH });
    expect(started.json).toMatchObject({ startOdometer: 15020.4, startLabel: '12500 Lake City Way NE, Seattle' });
    expect(tesla.calls.some((c) => c.includes('/wake_up'))).toBe(true);

    tesla.drive(12.4);
    const ended = await call('POST', `/trips/${(started.json as { id: string }).id}/end`, {});
    expect(ended.json).toMatchObject({ source: 'tesla', endOdometer: 15032.8, miles: 12.4, endLabel: '6500 32nd Ave NW, Seattle' });
  });

  it('reports Tesla as not configured without a client', async () => {
    const plain = createApp(pool, createAuthenticator({ authMode: 'dev', tenantId: null, apiClientId: null }));
    const res = await plain.handle(request('GET', '/tesla/status'));
    expect(res.json).toEqual({ configured: false, connected: false });
    expect((await plain.handle(request('POST', '/tesla/connect'))).status).toBe(503);
  });
});

describe('Tesla token handling', () => {
  it('saves the rotated refresh token on every refresh', async () => {
    const t = fakeTesla();
    const store = new MemoryTokenStore();
    await store.set('u1', 'refresh-0');
    const client = new TeslaClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, store, t.fetchImpl, async () => {});
    await client.listVehicles('u1');
    expect(store.tokens.get('u1')).toBe('refresh-1');
  });
});

describe('formatAddress', () => {
  it('prefers street and city over the long formatted address', () => {
    const body = {
      features: [
        {
          properties: {
            address: {
              addressLine: '15127 NE 24th St',
              locality: 'Redmond',
              formattedAddress: '15127 NE 24th St, Redmond, Washington 98052',
            },
          },
        },
      ],
    };
    expect(formatAddress(body)).toBe('15127 NE 24th St, Redmond');
    expect(formatAddress({ features: [] })).toBeNull();
  });
});
