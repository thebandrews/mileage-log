using './main.bicep'

// Non-secret values. The Postgres password comes from the POSTGRES_ADMIN_PASSWORD
// GitHub secret in the deploy workflow (or `-p postgresAdminPassword=...` by hand).
param appName = 'mileagelog'
param location = 'westus2'
param staticWebAppLocation = 'westus2'
// Sign-in uses the Pacifica Landscapes tenant even though resources live in another subscription.
param entraTenantId = readEnvironmentVariable('ENTRA_TENANT_ID', '4712cd50-fdbe-47a5-b632-f5d5e5e1a61b')
param entraApiClientId = readEnvironmentVariable('ENTRA_API_CLIENT_ID', '1e605472-f866-4d4d-a242-a17e6881ccaa')
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
