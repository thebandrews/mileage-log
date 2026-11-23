import { AzureMapsGeocoder, noGeocoder, type Geocoder } from './geocode.js';
import { KeyVaultTokenStore, MemoryTokenStore, TeslaClient } from './tesla.js';

/** An app setting holding a Key Vault reference that didn't resolve (e.g. the secret isn't set yet). */
const unresolved = (v: string | undefined) => !v || v.startsWith('@Microsoft.KeyVault(');

/** Optional services, switched on by app settings. Missing settings just turn the feature off. */
export function servicesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  geocoder: Geocoder;
  tesla: TeslaClient | null;
} {
  const geocoder = env.MAPS_CLIENT_ID ? new AzureMapsGeocoder(env.MAPS_CLIENT_ID) : noGeocoder;

  let tesla: TeslaClient | null = null;
  if (!unresolved(env.TESLA_CLIENT_ID) && !unresolved(env.TESLA_CLIENT_SECRET) && env.TESLA_REDIRECT_URI) {
    const store = env.KEY_VAULT_URI ? new KeyVaultTokenStore(env.KEY_VAULT_URI) : new MemoryTokenStore();
    tesla = new TeslaClient(
      { clientId: env.TESLA_CLIENT_ID!, clientSecret: env.TESLA_CLIENT_SECRET!, redirectUri: env.TESLA_REDIRECT_URI },
      store,
    );
  }
  return { geocoder, tesla };
}
