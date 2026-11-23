/**
 * Tesla Fleet API: OAuth (third-party tokens) and on-demand odometer/location reads.
 * Start/End needs two reads per trip, which Tesla prices at $0.002 each — far inside the
 * $10 monthly account credit — so no streaming is involved here.
 */
import { randomBytes } from 'node:crypto';
import type { Point } from './repo.js';
import { HttpError } from './http.js';

export const TESLA_AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
export const TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
export const TESLA_NA_API = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
export const TESLA_SCOPES = ['openid', 'offline_access', 'vehicle_device_data', 'vehicle_location'];

export interface TeslaConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the redirect URI registered with Tesla. */
  redirectUri: string;
  apiBase?: string;
}

export interface TeslaTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface TeslaVehicle {
  vin: string;
  name: string;
}

export interface TeslaReading {
  /** Miles, one decimal place. */
  odometer: number;
  location: Point | null;
}

/** Where each user's latest refresh token is kept (Key Vault in Azure). */
export interface TokenStore {
  get(userId: string): Promise<string | null>;
  set(userId: string, refreshToken: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  readonly tokens = new Map<string, string>();
  async get(userId: string) {
    return this.tokens.get(userId) ?? null;
  }
  async set(userId: string, refreshToken: string) {
    this.tokens.set(userId, refreshToken);
  }
}

/** Refresh tokens as Key Vault secrets named tesla-refresh-<user id>, via the managed identity. */
export class KeyVaultTokenStore implements TokenStore {
  private client: Promise<any> | null = null;
  constructor(private readonly vaultUri: string) {}

  private secrets() {
    this.client ??= (async () => {
      const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
        import('@azure/identity'),
        import('@azure/keyvault-secrets'),
      ]);
      return new SecretClient(this.vaultUri, new DefaultAzureCredential());
    })();
    return this.client;
  }

  async get(userId: string) {
    try {
      return (await (await this.secrets()).getSecret(`tesla-refresh-${userId}`)).value ?? null;
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async set(userId: string, refreshToken: string) {
    await (await this.secrets()).setSecret(`tesla-refresh-${userId}`, refreshToken, {
      contentType: 'tesla-refresh-token',
    });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TeslaClient {
  private readonly apiBase: string;
  private readonly access = new Map<string, TeslaTokens>();

  constructor(
    private readonly config: TeslaConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.apiBase = config.apiBase ?? TESLA_NA_API;
  }

  static newState(): string {
    return randomBytes(24).toString('base64url');
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: TESLA_SCOPES.join(' '),
      state,
      prompt_missing_scopes: 'true',
    });
    return `${TESLA_AUTHORIZE_URL}?${q}`;
  }

  /** Finishes the OAuth redirect and keeps the refresh token. */
  async connect(userId: string, code: string): Promise<void> {
    const tokens = await this.token({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      audience: this.apiBase,
      redirect_uri: this.config.redirectUri,
    });
    await this.remember(userId, tokens);
  }

  async listVehicles(userId: string): Promise<TeslaVehicle[]> {
    const body = await this.api(userId, 'GET', '/api/1/vehicles');
    return (body.response ?? []).map((v: any) => ({
      vin: String(v.vin),
      name: v.display_name || `Tesla ${String(v.vin).slice(-6)}`,
    }));
  }

  /** Current odometer and location. Wakes the car if it's asleep (rare when you're in it). */
  async read(userId: string, vin: string): Promise<TeslaReading> {
    const path = `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data?endpoints=${encodeURIComponent(
      'vehicle_state;location_data',
    )}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await this.api(userId, 'GET', path);
        const r = body.response ?? {};
        const odometer = Number(r.vehicle_state?.odometer);
        if (!Number.isFinite(odometer)) throw new HttpError(502, 'Tesla did not return an odometer reading');
        const lat = r.drive_state?.latitude;
        const lng = r.drive_state?.longitude;
        return {
          odometer: Math.round(odometer * 10) / 10,
          location: typeof lat === 'number' && typeof lng === 'number' ? { latitude: lat, longitude: lng } : null,
        };
      } catch (err) {
        const asleep = err instanceof TeslaError && err.status === 408;
        if (!asleep || attempt >= 6) {
          if (asleep) throw new HttpError(504, 'The car is asleep and did not wake up in time');
          throw err;
        }
        if (attempt === 0) await this.api(userId, 'POST', `/api/1/vehicles/${encodeURIComponent(vin)}/wake_up`);
        await this.wait(5000);
      }
    }
  }

  private async remember(userId: string, tokens: TeslaTokens) {
    this.access.set(userId, tokens);
    await this.store.set(userId, tokens.refreshToken);
  }

  private async accessToken(userId: string): Promise<string> {
    const cached = this.access.get(userId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken;
    const refreshToken = cached?.refreshToken ?? (await this.store.get(userId));
    if (!refreshToken) throw new HttpError(409, 'Connect your Tesla account first');
    // Refresh tokens are single use: always save the new one.
    const tokens = await this.token({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });
    await this.remember(userId, tokens);
    return tokens.accessToken;
  }

  private async token(form: Record<string, string>): Promise<TeslaTokens> {
    const res = await this.fetchImpl(TESLA_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      if (res.status === 401 || body.error === 'login_required') {
        throw new HttpError(409, 'Your Tesla sign-in expired. Reconnect your Tesla account.');
      }
      throw new HttpError(502, `Tesla sign-in failed (${body.error ?? res.status})`);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    };
  }

  private async api(userId: string, method: string, path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken(userId)}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new TeslaError(res.status, body.error ?? `HTTP ${res.status}`);
    return body;
  }
}

export class TeslaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Tesla API: ${message}`);
  }
}
