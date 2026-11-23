// Makes a service principal the Entra admin of a PostgreSQL flexible server.
// A module because the resource name is the principal's object ID, which is only
// known once the identity exists.
param serverName string
param principalId string
param principalName string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: principalName
    tenantId: tenant().tenantId
  }
}
