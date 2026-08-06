targetScope = 'resourceGroup'

@description('Azure region for the Logic App, Key Vault, and API connection.')
param location string = resourceGroup().location

@description('Name of the Consumption Logic App.')
param logicAppName string

@description('Globally unique name of the Key Vault.')
param keyVaultName string

@description('Name of the Key Vault API connection.')
param keyVaultConnectionName string = '${logicAppName}-keyvault'

@description('Full resource ID of the existing Azure Front Door Standard/Premium profile. The profile can be in another resource group or subscription in the same tenant.')
param frontDoorResourceId string

@description('Base URL of the GOV.CZ DNS API.')
param dnsGovApiUrl string

@description('GOV.CZ domain name managed by the workflow.')
param govZoneName string

@description('GOV.CZ domain ID managed by the workflow.')
param govDomainId string

@secure()
@description('GOV.CZ API key stored as the govcz-api-key Key Vault secret.')
param govCzApiKey string

@description('Grant the identity executing this deployment the Key Vault Secrets Officer role on the deployed Key Vault.')
param grantKeyVaultSecretsOfficerToDeployer bool = false

@description('Optional tags applied to deployed resources.')
param tags object = {}

param keyVaultTags object = {}

var workflowSource = loadJsonContent('logicapp.json')
var keyVaultSecretName = 'govcz-api-key'
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var keyVaultSecretsOfficerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

var frontDoorIdParts = split(frontDoorResourceId, '/')
var frontDoorSubscriptionId = frontDoorIdParts[2]
var frontDoorResourceGroupName = frontDoorIdParts[4]
var frontDoorProfileName = frontDoorIdParts[8]
var normalizedDnsGovApiUrl = endsWith(dnsGovApiUrl, '/')
  ? substring(dnsGovApiUrl, 0, max([length(dnsGovApiUrl) - 1, 0]))
  : dnsGovApiUrl

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: keyVaultTags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

resource govCzApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: keyVaultSecretName
  properties: {
    value: govCzApiKey
  }
}

resource keyVaultConnection 'Microsoft.Web/connections@2016-06-01' = {
  name: keyVaultConnectionName
  location: location
  tags: tags
  properties: any({
    displayName: keyVaultConnectionName
    parameterValueType: 'Alternative'
    alternativeParameterValues: {
      vaultName: keyVault.name
    }
    api: {
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'keyvault')
    }
  })
}

resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: workflowSource.definition
    parameters: {
      dnsGovApiUrl: {
        value: normalizedDnsGovApiUrl
      }
      govZoneName: {
        value: govZoneName
      }
      govDomainId: {
        value: govDomainId
      }
      frontDoorResourceId: {
        value: frontDoorResourceId
      }
      '$connections': {
        value: {
          keyvault: {
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'keyvault')
            connectionId: keyVaultConnection.id
            connectionName: keyVaultConnection.name
            connectionProperties: {
              authentication: {
                type: 'ManagedServiceIdentity'
              }
            }
          }
        }
      }
    }
  }
}

resource keyVaultSecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, logicApp.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: logicApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVaultSecretsOfficerDeployerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantKeyVaultSecretsOfficerToDeployer) {
  name: guid(keyVault.id, deployer().objectId, keyVaultSecretsOfficerRoleDefinitionId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleDefinitionId
    principalId: deployer().objectId
  }
}

module frontDoorRbac 'front-door-rbac.bicep' = {
  name: 'front-door-rbac-${uniqueString(frontDoorResourceId, logicApp.id)}'
  scope: resourceGroup(frontDoorSubscriptionId, frontDoorResourceGroupName)
  params: {
    frontDoorProfileName: frontDoorProfileName
    principalId: logicApp.identity.principalId
  }
}

output logicAppResourceId string = logicApp.id
output logicAppPrincipalId string = logicApp.identity.principalId
output keyVaultResourceId string = keyVault.id
output keyVaultConnectionResourceId string = keyVaultConnection.id
