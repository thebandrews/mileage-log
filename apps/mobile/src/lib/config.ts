// EXPO_PUBLIC_* variables are inlined at build time; they must be read as literal
// process.env.EXPO_PUBLIC_X expressions for the bundler to replace them.
export const config = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:7071/api').replace(/\/$/, ''),
  authMode: (process.env.EXPO_PUBLIC_AUTH_MODE === 'dev' ? 'dev' : 'entra') as 'dev' | 'entra',
  devUser: process.env.EXPO_PUBLIC_DEV_USER ?? 'dev',
  tenantId: process.env.EXPO_PUBLIC_ENTRA_TENANT_ID ?? '',
  clientId: process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID ?? '',
  apiScope: process.env.EXPO_PUBLIC_ENTRA_API_SCOPE ?? '',
};

export const entraConfigured = Boolean(config.tenantId && config.clientId && config.apiScope);
