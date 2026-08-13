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

@description('Optional base URL of the GOV.CZ DNS API. When empty, the Logic App parameter is not set.')
param dnsGovApiUrl string = ''

@description('GOV.CZ domain name managed by the workflow.')
param govZoneName string

@description('GOV.CZ domain ID managed by the workflow.')
param govDomainId string

@description('User principal name of the mailbox used to send notification emails.')
param emailNotificationSenderUpn string

@description('Email address that receives workflow notifications.')
param emailNotificationReceipient string

@secure()
@description('GOV.CZ API key stored as the govcz-api-key Key Vault secret.')
param govCzApiKey string

@description('Create or update the govcz-api-key Key Vault secret.')
param deployApiKeySecret bool = false

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

param managedIdentityName string = 'mi-govcz-fd'

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2018-11-30' = {
  name: managedIdentityName
  location: location
}

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

resource govCzApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (deployApiKeySecret) {
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
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    state: 'Enabled'
    definition: workflowSource.definition
    parameters: {
      ...(!empty(dnsGovApiUrl) ? {
        dnsGovApiUrl: {
          value: normalizedDnsGovApiUrl
        }
      } : {})
      govZoneName: {
        value: govZoneName
      }
      govDomainId: {
        value: govDomainId
      }
      emailNotificationSenderUpn: {
        value: emailNotificationSenderUpn
      }
      emailNotificationReceipient: {
        value: emailNotificationReceipient
      }
      frontDoorResourceId: {
        value: frontDoorResourceId
      }
      managedIdentityResourceId: {
        value: managedIdentity.id
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
                identity: managedIdentity.id
              }
            }
          }
        }
      }
    }
  }
}

resource keyVaultSecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: managedIdentity.properties.principalId
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
  name: 'front-door-rbac-${uniqueString(frontDoorResourceId, managedIdentity.id)}'
  scope: resourceGroup(frontDoorSubscriptionId, frontDoorResourceGroupName)
  params: {
    frontDoorProfileName: frontDoorProfileName
    principalId: managedIdentity.properties.principalId
  }
}

output logicAppResourceId string = logicApp.id
output logicAppPrincipalId string = managedIdentity.properties.principalId
output keyVaultResourceId string = keyVault.id
output keyVaultConnectionResourceId string = keyVaultConnection.id
