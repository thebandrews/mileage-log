using './main.bicep'

// Every value here is a public identifier. There are no secrets: GitHub signs in to
// Azure with OIDC and the API signs in to Postgres with its managed identity.
param appName = 'mileagelog'
param location = 'westus2'
param staticWebAppLocation = 'westus2'
// Sign-in uses the Pacifica Landscapes tenant even though resources live in another subscription.
param entraTenantId = readEnvironmentVariable('ENTRA_TENANT_ID', '4712cd50-fdbe-47a5-b632-f5d5e5e1a61b')
param entraApiClientId = readEnvironmentVariable('ENTRA_API_CLIENT_ID', '1e605472-f866-4d4d-a242-a17e6881ccaa')
// Tesla developer app "Millage Log" (public client ID). The client secret lives only in Key Vault.
param teslaClientId = '995a5c1a-d271-4678-8c9b-a8869b4a74a2'
