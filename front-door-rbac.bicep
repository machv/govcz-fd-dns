targetScope = 'resourceGroup'

@description('Name of the existing Azure Front Door Standard/Premium profile.')
param frontDoorProfileName string

@description('Object ID of the Logic App managed identity.')
param principalId string

var cdnProfileContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ec156ff8-a8d1-4d15-830c-5b80698ca432'
)

resource frontDoorProfile 'Microsoft.Cdn/profiles@2025-04-15' existing = {
  name: frontDoorProfileName
}

resource frontDoorRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(frontDoorProfile.id, principalId, cdnProfileContributorRoleDefinitionId)
  scope: frontDoorProfile
  properties: {
    roleDefinitionId: cdnProfileContributorRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
