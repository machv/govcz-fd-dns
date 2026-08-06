# Logic App infrastructure

`main.bicep` deploys:

- the Consumption Logic App from `logicapp.json` with a system-assigned managed identity;
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

az deployment group create --resource-group rg-govdns --parameters main.bicepparam
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
