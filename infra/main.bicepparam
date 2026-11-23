using './main.bicep'

// Non-secret values. The Postgres password comes from the POSTGRES_ADMIN_PASSWORD
// GitHub secret in the deploy workflow (or `-p postgresAdminPassword=...` by hand).
param appName = 'mileagelog'
param location = 'westus2'
param staticWebAppLocation = 'westus2'
param entraApiClientId = readEnvironmentVariable('ENTRA_API_CLIENT_ID', '')
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
