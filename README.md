# Logic App pro automatizaci validačních TXT záznamů pro Azure Front Door

Šablona `main.bicep` nasadí:

- uživatelem přiřazenou spravovanou identitu (UAMI), kterou používá Consumption Logic App definovaná v `logicapp.json`
- Key Vault s povoleným RBAC, který obsahuje API klíč `govcz-api-key`
- API připojení ke Key Vault s využitím spravované identity
- roli `Key Vault Secrets User` pro Logic App na úrovni Key Vaultu
- roli `CDN Profile Contributor` na už existující Front Door profil

Role `CDN Profile Contributor` je potřeba z důvodu volání operace `refreshValidationToken` v případě expirovaného TXT záznamu.

Front Door Resource ID může odkazovat na jinou skupinu prostředků nebo jiné předplatné v rámci jednoho Entra ID tenantu. Identita pod kterou se spouští Bicep musí mít oprávnění vytvářet přiřazení rolí na daném profilu Front Door a Key Vaultu. Bicep skript musí být spuštěn na skupině prostředků.

Soubor `main.bicepparam` umožňuje přizpůsobení nasazení na vaše prostředí. 

Vzorový soubor parametrů může vypadat následovně:

```
using './main.bicep'

param logicAppName = 'la-govcz-fd'
param keyVaultName = 'kv-govcz-fd-contoso'
param frontDoorResourceId = '/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Cdn/profiles/<profile-name>'
param govZoneName = 'contoso.gov.cz'
param govDomainId = '<gov-cz-domain-id>'
param emailNotificationSenderUpn = 'sluzebnicek@contoso.gov.cz'
param emailNotificationReceipient = 'admin@consoto.gov.cz'
param govCzApiKey = readEnvironmentVariable('GOVCZ_API_KEY', '')
param grantKeyVaultSecretsOfficerToDeployer = true
```

API klíč následně předejte prostřednictvím proměnné prostředí:

```bash
export GOVCZ_API_KEY='<api-key>'

az group create --location swedencentral --name rg-govdns

# První nasazení včetně API klíče v Key Vault
az deployment group create --resource-group <RG-NAME> --parameters main.bicepparam --parameters deployApiKeySecret=true

# Při dalších nasazeních lze aktualizaci tajného klíče vynechat (výchozí chování)
az deployment group create --resource-group <RG-NAME> --parameters main.bicepparam
```

Případně lze všechny parametry předat explicitně:

```bash
az deployment group create \
  --resource-group <logic-app-resource-group> \
  --template-file main.bicep \
  --parameters \
    logicAppName=<logic-app-name> \
    keyVaultName=<globally-unique-key-vault-name> \
    frontDoorResourceId='/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Cdn/profiles/<profile-name>' \
    govDomainName='<domain-name>' \
    govDomainId='<domain-id>' \
    govCzApiKey='<api-key>'
```

## Udělení oprávnění k odesílání e-mailů

Tato Logic App používá uživatelem přiřazenou spravovanou identitu (UAMI) k volání Microsoft Graph API a odesílání e-mailů z poštovní schránky, která může být i sdílená. K tomu potřebuje aplikační oprávnění `Mail.Send`, které musí přiřadit globální správce.

Pro spuštění je potřeba PowerShell modulu `Microsoft.Graph`.

```powershell
$managedIdentityServicePrincipalId = az ad sp list --filter "displayName eq 'mi-govcz-fd'" --query "[0].id" --output tsv
$microsoftGraphServicePrincipalId = az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" --output tsv
$appRoleId = az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].appRoles[?value=='Mail.Send' && contains(allowedMemberTypes, 'Application')].id | [0]" --output tsv

Connect-MgGraph -Scopes 'Directory.Read.All', 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All'
$appRoleAssignment = @{
  "PrincipalId" = $managedIdentityServicePrincipalId
  "ResourceId" = $microsoftGraphServicePrincipalId
  "AppRoleId" = $appRoleId
}
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appRoleAssignment.PrincipalId -BodyParameter $appRoleAssignment -Verbose
```
