# Logic App infrastructure

`main.bicep` deploys:

- a user-assigned managed identity used by the Consumption Logic App from `logicapp.json`;
- an RBAC-enabled Key Vault containing the `govcz-api-key` secret;
- a managed-identity Key Vault API connection;
- `Key Vault Secrets User` for the Logic App identity;
- `CDN Profile Contributor` on the existing Front Door profile.

`CDN Profile Contributor` is required because the workflow both lists custom domains and calls `refreshValidationToken`.

The Front Door resource ID can point to another resource group or subscription in the same Microsoft Entra tenant. The deployment identity must be allowed to create role assignments on that Front Door profile, and the deployment must be started at resource-group scope.

`main.bicepparam` contains the current Front Door resource ID and workflow settings. Supply the secret through the environment:

```bash
export GOVCZ_API_KEY='<api-key>'

az group create --location swedencentral --name rg-govdns

az deployment group create --resource-group rg-govdns --parameters main.bicepparam --parameters deployApiKeySecret=true
```

Alternatively, pass all parameters explicitly:

```bash
az deployment group create \
  --resource-group <logic-app-resource-group> \
  --template-file main.bicep \
  --parameters \
    logicAppName=<logic-app-name> \
    keyVaultName=<globally-unique-key-vault-name> \
    frontDoorResourceId='/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Cdn/profiles/<profile-name>' \
    dnsGovApiUrl='https://<dns-api-host>' \
    govDomainName='<domain-name>' \
    govDomainId='<domain-id>' \
    govCzApiKey='<api-key>'
```

## Grant rights to send email

Logic App uses User-assigned Managed Identity to call Graph API to send email from mailbox (can be shared one). In order to do that it needs `Mail.Send` permission.

```powershell
$managedIdentityServicePrincipalId = az ad sp list --filter "displayName eq 'mi-govczdns'" --query "[0].id" --output tsv
$microsoftGraphServicePrincipalId = az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" --output tsv
$appRoleId = az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].appRoles[?value=='Mail.Send' && contains(allowedMemberTypes, 'Application')].id | [0]" --output tsv


Connect-MgGraph -Scopes 'Directory.ReadWrite.All','User.Read','Application.ReadWrite.All','AppRoleAssignment.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All'
$appRoleAssignment = @{
  "PrincipalId" = $managedIdentityServicePrincipalId
  "ResourceId" = $microsoftGraphServicePrincipalId
  "AppRoleId" = $appRoleId
}
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appRoleAssignment.PrincipalId -BodyParameter $appRoleAssignment -Verbose
```
