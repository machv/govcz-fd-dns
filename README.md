# Automatizace validačních TXT záznamů Azure Front Door pro GOV.CZ

Zóny hostované v rámci GOV.CZ DNS infrastruktury umožňují API přístup pro automatizaci správy DNS záznamů. Tato Logic App automaticky pro vybraný Front Door profil sleduje přidané domény a pokud je potřeba TXT záznam přidat/změnit, automaticky, s využitím API klíče (s oprávněním `write`), změnu provede. Notifikace o průběhu se posílají na e-mail s využitím Graph API (a tedy není potřeba žádné dodatečné licence).

Logic App se spouští jednou denně a kontroluje vlastní domény nakonfigurované v určeném Azure Front Door profilu. 

  1. Načte domény, které čekají na DNS validaci nebo revalidaci.
  1. Z Key Vault získá API klíč pro GOV.CZ DNS API.
  1. Ověří, že nastavená GOV.CZ zóna odpovídá zadanému ID domény.
  1. Pro každou čekající doménu načte nebo obnoví validační token Front Door.
  1. V GOV.CZ DNS vytvoří chybějící TXT záznam nebo aktualizuje jeho neplatnou hodnotu.
  1. Volitelně pomocí Microsoft Graph odešle průběžné e-mailové notifikace. Odesílání notifikací lze vypnout parametrem emailNotificationsEnabled.

Přístupy k Azure Front Door, Key Vault a Microsoft Graph probíhají prostřednictvím uživatelem přiřazené spravované identity.

> [!TIP]
> Pokud máte v prostředí více Front Door profilů, stačí tuto Logic App nasadit ve více instancích, každá bude obsluhovat svůj Front Door profil. 
> Stejně tak, pokud máte více gov.cz zón, které se na Front Door profilu používají, stačí stejnou Logic App nasadit vícekrát vůči stejnému Front Profilu, pro každou gov.cz zónu.  


## Nasazení Logic App

Šablona `main.bicep` nasadí:

- uživatelem přiřazenou spravovanou identitu (UAMI), kterou používá Consumption Logic App definovaná v `logicapp.json`
- Key Vault s povoleným RBAC, který obsahuje API klíč `govcz-api-key`
- API připojení ke Key Vault s využitím spravované identity
- roli `Key Vault Secrets User` pro Logic App na úrovni Key Vaultu
- roli `CDN Profile Contributor` na už existující Front Door profil
- volitelné pravidlo Azure Monitor pro metriku `Runs Failed`, které upozorní na neúspěšné běhy Logic App

Role `CDN Profile Contributor` je potřeba z důvodu volání operace `refreshValidationToken` v případě expirovaného TXT záznamu.

Pravidlo pro neúspěšné běhy je ve výchozím nastavení vypnuté. Zapnete ho parametrem `failedRunsAlertEnabled = true`; upozornění se odešlou na adresu z parametru `emailNotificationReceipient`.

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
param failedRunsAlertEnabled = true
param govCzApiKey = readEnvironmentVariable('GOVCZ_API_KEY', '')
param grantKeyVaultSecretsOfficerToDeployer = true
```

API klíč následně předejte prostřednictvím proměnné prostředí:

```bash
export GOVCZ_API_KEY='<api-key>'

az group create --location swedencentral --name rg-govdns

# První nasazení včetně API klíče v Key Vault
az deployment group create --resource-group rg-govdns --parameters main.bicepparam --parameters deployApiKeySecret=true

# Při dalších nasazeních lze aktualizaci tajného klíče vynechat (výchozí chování)
az deployment group create --resource-group rg-govdns --parameters main.bicepparam
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

Tato Logic App používá uživatelem přiřazenou spravovanou identitu (UAMI) k volání Microsoft Graph API a odesílání e-mailů z poštovní schránky, která může být i sdílená. 

Jsou dva způsoby, jak můžeme toto oprávnění udělit.

  1. Graph API  oprávnění `Mail.Send` na úrovni UAMI Enterprise Application
  1. Exchange Online RBAC role `Application Mail.Send` pro UAMI 

Opravnění stačí přidělit jedním z těchto způsobů.

### Graph API

> [!CAUTION]
> Tato varianta udělí oprávnění `Mail.Send` na úrovni celého tenantu, spravovaná identita tedy má možnost odeslat email z libovolné poštovní schránky.

Pro spuštění je potřeba PowerShell modul `Microsoft.Graph`.

```powershell
Connect-MgGraph -Scopes 'Directory.Read.All', 'AppRoleAssignment.ReadWrite.All', 'Application.Read.All'

$managedIdentityName = "mi-govcz-fd"
$managedIdentityServicePrincipal = Get-MgServicePrincipal -Filter "DisplayName eq '$managedIdentityName'"
$microsoftGraphServicePrincipal = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$appRoleId = $microsoftGraphServicePrincipal.AppRoles | Where-Object Value -eq "Mail.Send" | Select-Object -ExpandProperty Id

$appRoleAssignment = @{
  "PrincipalId" = $managedIdentityServicePrincipal.Id
  "ResourceId" = $microsoftGraphServicePrincipal.Id
  "AppRoleId" = $appRoleId
}

New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appRoleAssignment.PrincipalId -BodyParameter $appRoleAssignment -Verbose
```

### Exchange Online RBAC

> [!CAUTION]
> Tento způsob přiřazení omezí odesílání jen z vybrané poštovní schránky. Při změně odesílacího mailboxu je potřeba RBAC oprávnění upravit.

Pro spuštění je potřeba PowerShell modul `ExchangeOnlineManagement`.

```powershell
$managedIdentityName = "mi-govcz-fd"
$sendFromMailbox = "sluzebnicek@contoso.gov.cz"

$managedIdentityServicePrincipalId = az ad sp list --filter "displayName eq '$managedIdentityName'" --query "[0].id" --output tsv
$managedIdentityApplicationId = az ad sp list --filter "displayName eq '$managedIdentityName'" --query "[0].appId" --output tsv

Connect-ExchangeOnline

New-ManagementScope -Name "la-govcz-fd-notifications" -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$sendFromMailbox'"
New-ServicePrincipal -AppId $managedIdentityApplicationId -ObjectId $managedIdentityServicePrincipalId -DisplayName $managedIdentityName
New-ManagementRoleAssignment -Name "GovLogicAppMailSend" -Role "Application Mail.Send" -App $managedIdentityName -CustomResourceScope "la-govcz-fd-notifications"

```
