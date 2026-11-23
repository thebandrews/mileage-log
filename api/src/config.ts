export type AuthMode = 'entra' | 'dev';

export interface Config {
  authMode: AuthMode;
  /** Entra ID tenant (directory) ID. */
  tenantId: string | null;
  /** Application (client) ID of the API app registration. */
  apiClientId: string | null;
}

/** Running inside Azure App Service / Functions. */
export const inAzure = () => Boolean(process.env.WEBSITE_SITE_NAME);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? 'entra') as AuthMode;
  if (authMode !== 'entra' && authMode !== 'dev') {
    throw new Error(`AUTH_MODE must be "entra" or "dev", got "${authMode}"`);
  }
  if (authMode === 'dev' && env.WEBSITE_SITE_NAME) {
    // Never allow the header-based dev login on a deployed app.
    throw new Error('AUTH_MODE=dev is not allowed when running in Azure.');
  }
  const config: Config = {
    authMode,
    tenantId: env.ENTRA_TENANT_ID ?? null,
    apiClientId: env.ENTRA_API_CLIENT_ID ?? null,
  };
  if (authMode === 'entra' && (!config.tenantId || !config.apiClientId)) {
    throw new Error('ENTRA_TENANT_ID and ENTRA_API_CLIENT_ID are required when AUTH_MODE=entra.');
  }
  return config;
}
