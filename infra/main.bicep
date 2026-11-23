// Mileage Log — Azure resources for phase 1.
// Deploy into an existing resource group:
//   az deployment group create -g <rg> -f infra/main.bicep -p infra/main.bicepparam
targetScope = 'resourceGroup'

@description('Short name used to derive resource names (lowercase letters and digits).')
@minLength(3)
@maxLength(12)
param appName string = 'mileagelog'

@description('Region for everything except the Static Web App. Must support Flex Consumption.')
param location string = resourceGroup().location

@description('Static Web Apps is only offered in a few regions.')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param staticWebAppLocation string = 'westus2'

@description('Entra tenant that signs users in. May differ from the tenant hosting these resources.')
param entraTenantId string

@description('Application (client) ID of the "Mileage Log API" app registration.')
param entraApiClientId string

@description('Client ID of the Tesla developer app (public). Empty until Tesla approves the app; the Tesla feature stays off.')
param teslaClientId string = ''

@description('Extra browser origins allowed to call the API (e.g. http://localhost:8081 for Expo web dev).')
param extraCorsOrigins array = ['http://localhost:8081']

var suffix = uniqueString(resourceGroup().id, appName)
var names = {
  logs: '${appName}-logs'
  insights: '${appName}-insights'
  storage: take('${appName}${suffix}', 24)
  plan: '${appName}-plan'
  api: '${appName}-api-${take(suffix, 6)}'
  postgres: '${appName}-pg-${take(suffix, 6)}'
  maps: '${appName}-maps'
  vault: take('${appName}kv${suffix}', 24)
  web: '${appName}-web'
}
var deploymentContainer = 'app-package'
var databaseName = 'mileage'

var roles = {
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
  mapsDataReader: '423170ca-a8f6-4b0f-8487-9e4eb8f49bfa'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
}

// ---------- Monitoring ----------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logs
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: names.insights
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    DisableLocalAuth: true
  }
}

// ---------- Storage for the Functions host and deployment package ----------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: names.storage
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    defaultToOAuthAuthentication: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource packageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainer
}

// ---------- PostgreSQL (Entra authentication only: no passwords exist) ----------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: names.postgres
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    authConfig: {
      passwordAuth: 'Disabled'
      activeDirectoryAuth: 'Enabled'
      tenantId: tenant().tenantId
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Flex Consumption has no fixed outbound IPs, so allow Azure services (0.0.0.0).
// Connections still need a valid Entra token and TLS. Tighten with VNet integration later.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------- Azure Maps (destination addresses; Entra auth only, no keys) ----------

resource maps 'Microsoft.Maps/accounts@2023-06-01' = {
  name: names.maps
  location: location
  kind: 'Gen2'
  sku: { name: 'G2' }
  properties: { disableLocalAuth: true }
}

// ---------- Key Vault (Tesla app secret, Tesla refresh tokens, Tesla partner key) ----------
// Nothing in here is ever stored in GitHub. The Tesla client secret is added once by hand;
// the partner key is created inside the vault and never leaves it (only its public half is published).

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.vault
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
  }
}

// The deploy identity creates the partner key if missing and publishes its public half.
resource deployerKeyRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deployer().objectId, roles.keyVaultCryptoOfficer)
  scope: vault
  properties: {
    principalId: deployer().objectId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultCryptoOfficer)
  }
}

// ---------- Static Web App (web build of the Expo app) ----------

resource web 'Microsoft.Web/staticSites@2024-04-01' = {
  name: names.web
  location: staticWebAppLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

// ---------- Function App (API) ----------

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: names.plan
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource api 'Microsoft.Web/sites@2024-04-01' = {
  name: names.api
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: concat(['https://${web.properties.defaultHostname}'], extraCorsOrigins)
      }
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 512
      }
      runtime: { name: 'node', version: '22' }
    }
  }
  dependsOn: [packageContainer]
}

resource storageRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in [roles.storageBlobDataOwner, roles.storageQueueDataContributor, roles.storageTableDataContributor]: {
    name: guid(storage.id, api.id, roleId)
    scope: storage
    properties: {
      principalId: api.identity.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

resource mapsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(maps.id, api.id, roles.mapsDataReader)
  scope: maps
  properties: {
    principalId: api.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.mapsDataReader)
  }
}

resource vaultSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, api.id, roles.keyVaultSecretsOfficer)
  scope: vault
  properties: {
    principalId: api.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
  }
}

resource insightsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, api.id, roles.monitoringMetricsPublisher)
  scope: insights
  properties: {
    principalId: api.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
  }
}

// The API's managed identity is the database's Entra admin, so it signs in with
// short-lived tokens. Created after the other server changes (one at a time).
module pgAdmin 'modules/pg-admin.bicep' = {
  name: 'pg-entra-admin'
  params: {
    serverName: postgres.name
    principalId: api.identity.principalId
    principalName: api.name
  }
  dependsOn: [database, allowAzure]
}

resource apiSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: api
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__blobServiceUri: storage.properties.primaryEndpoints.blob
    AzureWebJobsStorage__queueServiceUri: storage.properties.primaryEndpoints.queue
    AzureWebJobsStorage__tableServiceUri: storage.properties.primaryEndpoints.table
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    APPLICATIONINSIGHTS_AUTHENTICATION_STRING: 'Authorization=AAD'
    AUTH_MODE: 'entra'
    ENTRA_TENANT_ID: entraTenantId
    ENTRA_API_CLIENT_ID: entraApiClientId
    PGHOST: postgres.properties.fullyQualifiedDomainName
    PGPORT: '5432'
    PGDATABASE: databaseName
    PGUSER: api.name
    PG_AUTH: 'entra'
    PGSSLMODE: 'require'
    MAPS_CLIENT_ID: maps.properties.uniqueId
    KEY_VAULT_URI: vault.properties.vaultUri
    TESLA_CLIENT_ID: teslaClientId
    TESLA_CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=tesla-client-secret)'
    TESLA_REDIRECT_URI: 'https://${web.properties.defaultHostname}/tesla/callback'
  }
  dependsOn: [pgAdmin, storageRoleAssignments, insightsRole, mapsRole, vaultSecretsRole]
}

output apiName string = api.name
output apiBaseUrl string = 'https://${api.properties.defaultHostName}/api'
output webName string = web.name
output webUrl string = 'https://${web.properties.defaultHostname}'
output keyVaultName string = vault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
