import type { Point } from './repo.js';

export interface Geocoder {
  /** A readable address for a point, or null when unknown. Never throws. */
  reverse(p: Point): Promise<string | null>;
}

export const noGeocoder: Geocoder = { reverse: async () => null };

interface TokenSource {
  getToken(scope: string): Promise<{ token: string } | null>;
}

/**
 * Azure Maps reverse geocoding with the app's managed identity (no keys).
 * MAPS_CLIENT_ID is the Maps account's uniqueId, a public identifier.
 */
export class AzureMapsGeocoder implements Geocoder {
  private credential: TokenSource | undefined;

  constructor(
    private readonly mapsClientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    credential?: TokenSource,
  ) {
    this.credential = credential;
  }

  async reverse(p: Point): Promise<string | null> {
    try {
      this.credential ??= new (await import('@azure/identity')).DefaultAzureCredential();
      const token = await this.credential.getToken('https://atlas.microsoft.com/.default');
      if (!token) return null;
      const url =
        'https://atlas.microsoft.com/reverseGeocode?api-version=2026-01-01' +
        `&coordinates=${p.longitude},${p.latitude}`;
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token.token}`, 'x-ms-client-id': this.mapsClientId },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return formatAddress(await res.json());
    } catch (err) {
      console.warn('Reverse geocoding failed', err);
      return null;
    }
  }
}

/** "1234 NW 65th St, Seattle" from an Azure Maps reverseGeocode response. */
export function formatAddress(body: any): string | null {
  const address = body?.features?.[0]?.properties?.address;
  if (!address) return null;
  const line = address.addressLine ?? [address.streetNumber, address.streetName].filter(Boolean).join(' ');
  const place = address.locality ?? address.neighborhood ?? null;
  const short = [line, place].filter(Boolean).join(', ');
  return short || address.formattedAddress || null;
}
